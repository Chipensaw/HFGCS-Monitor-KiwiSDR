'use strict';
//
// select.js -- which receiver listens to which frequency, right now.
//
// Filter hard, then rank. The filters are etiquette and capability; the
// ranking is quality and propagation.
//
// ETIQUETTE IS A FILTER, NOT A WEIGHT
// -----------------------------------
// A receiver with usersMax=2 loses half its capacity to one of our sessions;
// an 8-slot site loses an eighth. Proxied endpoints spend someone else's
// bandwidth on infrastructure donated to the community. Neither is something
// a good score should be able to outvote, so both are filters.
//
// PROPAGATION IS A HEURISTIC HERE, DELIBERATELY
// ---------------------------------------------
// The proper input is the UDXF per-station schedule -- which HFGCS ground
// stations are up on which frequency by UTC hour -- combined with the path
// midpoint between station and receiver. That table has not been transcribed
// yet, so this uses solar elevation AT THE RECEIVER as a stand-in: low bands
// want a dark receive end, high bands a lit one.
//
// That is a real simplification and it should be replaced, not defended. It
// captures the dominant term (whether the band is open where we are
// listening) and misses the rest (where the transmitter is). Phase 2 replaces
// it with measured per-frequency-per-hour detection rates from our own data,
// which will beat any model.

const fs = require('fs');
const path = require('path');

const RAD = Math.PI / 180;

/**
 * Solar elevation in degrees. NOAA low-precision algorithm; good to ~0.5deg,
 * far tighter than a day/night decision needs.
 */
function solarElevation(when, latDeg, lonDeg) {
  const jd = new Date(when).getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;

  const L = (280.460 + 0.9856474 * n) % 360;           // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;   // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;

  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));

  let gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  if (gmst < 0) gmst += 24;
  const lmst = (gmst * 15 + lonDeg) * RAD;

  const ha = lmst - ra;
  const lat = latDeg * RAD;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;
}

/** -1 night, +1 day, 0 either. */
function preferenceFor(freqKHz) {
  if (freqKHz <= 5000) return -1;
  if (freqKHz <= 7000) return -1;
  if (freqKHz >= 14000) return 1;
  return 0;
}

/** 0..1 -- how well this receiver's local illumination suits the frequency. */
function propagationScore(freqKHz, elevationDeg) {
  const pref = preferenceFor(freqKHz);
  if (pref === 0) return 0.75;                  // 24H frequencies: mild, flat
  // Smooth transition across the terminator rather than a hard day/night cut;
  // grayline is where these bands are often best, not worst.
  const x = Math.max(-1, Math.min(1, elevationDeg / 12));
  return pref > 0 ? (x + 1) / 2 : (1 - x) / 2;
}

function parseBands(bands) {
  if (typeof bands !== 'string') return null;
  const m = /^(\d+)-(\d+)$/.exec(bands.trim());
  if (!m) return null;
  return { lowHz: Number(m[1]), highHz: Number(m[2]) };
}

function loadBlocklist(file) {
  const set = new Set();
  if (!file) return set;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return set; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    set.add(line.toLowerCase());
  }
  return set;
}

/** Path to the newest scores.json under a survey data root, or null. */
function findLatestScores(dataRoot) {
  try {
    const runs = fs.readdirSync(dataRoot)
      .filter((d) => /^run-/.test(d))
      .sort();
    for (let i = runs.length - 1; i >= 0; i--) {
      const p = path.join(dataRoot, runs[i], 'scores.json');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* absent */ }
  return null;
}

/**
 * Merge cohort receivers with survey scores.
 * Survey scores are a BONUS, never a gate: the survey's own selection bias
 * means the receivers it skipped are disproportionately the good ones.
 */
function loadPool(cohortPath, surveyDataRoot) {
  const cohort = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));
  const receivers = cohort.receivers || cohort;

  const scores = new Map();
  const sp = surveyDataRoot ? findLatestScores(surveyDataRoot) : null;
  if (sp) {
    try {
      const sj = JSON.parse(fs.readFileSync(sp, 'utf8'));
      for (const st of (sj.stations || [])) {
        const key = st.id || st.endpoint;
        if (key) scores.set(String(key), st);
      }
    } catch (_) { /* scores are optional */ }
  }

  return {
    scoresPath: sp,
    receivers: receivers.map((r) => {
      const s = scores.get(String(r.id)) || scores.get(String(r.endpoint)) || null;
      return Object.assign({}, r, {
        band: parseBands(r.bands),
        survey: s ? {
          score: Number(s.score) || 0,
          Q: (s.components && s.components.Q && Number(s.components.Q.value)) || 0,
          mains: s.mains || null,
          coverage: Number(s.coverage) || 0
        } : null
      });
    })
  };
}

class SiteSelector {
  constructor(pool, cfg) {
    this.receivers = pool.receivers || pool;
    this.cfg = Object.assign({
      minUsersMax: 4,
      allowProxied: false,
      requireAntConnected: true,
      requireBandCoverage: true,
      recentUsePenaltyHours: 24,
      // A host that refused a TCP connection is dead, not unlucky. The survey's
      // own final sweep logged 17 of 200 unreachable, so ~10% of any cohort
      // snapshot is stale. Retrying a dead host twice more just burns time
      // while 76 other eligible receivers sit idle.
      maxConsecutiveFailures: 1,
      // ...but a failure EXPIRES. One-strike retirement with no decay drains
      // the whole pool: 77 eligible receivers each fail once, eligible hits 0,
      // bestPropagation returns 0, and the gate mistakes an exhausted pool for
      // a closed band and parks the channel forever. Receivers come back;
      // the ban must not be permanent.
      failureCooldownMinutes: 30,
      // Random pick across the top N by score. Too narrow and a handful of
      // high-scoring dead hosts get drawn over and over -- observed live:
      // ch11175 picked radio-hf.ofadam.com, failed, then picked it again.
      pickTopN: 15,
      // HFGCS ground stations are fixed: Andrews, Offutt, Puerto Rico,
      // Elmendorf, Hickam, Croughton, Guam, Yokota, Diego Garcia, Lajes,
      // Ascension. A receiver in Brazil at 23S is poorly placed to hear most
      // of them, so "no traffic" there may just mean "wrong place". Until the
      // UDXF schedule and a path-midpoint calculation land, this is the crude
      // stand-in: prefer receiver regions where a signal might plausibly
      // arrive. Empty list = no preference (previous behaviour).
      preferRegions: [],
      rankWeights: {
        propagation: 0.40, surveyQ: 0.25,
        mainsPenalty: 0.15, adcOvPenalty: 0.10, recentUsePenalty: 0.10,
        // Deliberately large: it must be able to outrank a marginally better
        // path at a useless location. Set it to 0 to disable without clearing
        // the region list.
        regionPreference: 0.35
      }
    }, cfg || {});
    this.blocklist = cfg && cfg.blocklist ? cfg.blocklist : new Set();
    this.lastUsed = new Map();      // key -> timestamp
    this.failures = new Map();      // key -> consecutive failures
  }

  key(r) { return String(r.endpoint || (r.host + ':' + r.port)); }

  isBlocked(r) {
    const k = this.key(r).toLowerCase();
    if (this.blocklist.has(k)) return true;
    const host = k.split(':')[0];
    return this.blocklist.has(host);
  }

  eligible(r, freqKHz) {
    if (this.isBlocked(r)) return false;
    if (this.cfg.requireAntConnected && r.antConnected === false) return false;
    if (Number(r.usersMax || 0) < this.cfg.minUsersMax) return false;
    if (!this.cfg.allowProxied && r.proxied) return false;
    const fail = this.failures.get(this.key(r));
    if (fail && fail.count >= this.cfg.maxConsecutiveFailures) {
      const ageMin = (Date.now() - fail.at) / 60000;
      if (ageMin < this.cfg.failureCooldownMinutes) return false;
      this.failures.delete(this.key(r));      // cooldown served
    }
    if (this.cfg.requireBandCoverage) {
      const b = r.band;
      const hz = freqKHz * 1000;
      if (!b || hz < b.lowHz || hz > b.highHz) return false;
    }
    return true;
  }

  score(r, freqKHz, when) {
    const w = this.cfg.rankWeights;

    let prop = 0.5;
    if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
      prop = propagationScore(freqKHz, solarElevation(when, r.lat, r.lon));
    }

    const q = r.survey ? Math.max(0, Math.min(1, r.survey.Q)) : 0.5;

    // mains: a hummy site is exactly wrong for weak EAM copy. The survey's
    // powerline detector is the one component it fully trusts, so use it.
    let mainsPenalty = 0;
    if (r.survey && r.survey.mains && Number.isFinite(r.survey.mains.db)) {
      mainsPenalty = Math.max(0, Math.min(1, r.survey.mains.db / 30));
    }

    let adcPenalty = 0;
    if (Number.isFinite(r.adcOv)) adcPenalty = Math.max(0, Math.min(1, r.adcOv / 100));

    const prefer = this.cfg.preferRegions || [];
    const regionBonus = (prefer.length && r.region && prefer.indexOf(r.region) !== -1) ? 1 : 0;

    const last = this.lastUsed.get(this.key(r)) || 0;
    const hours = (when - last) / 3600000;
    const recentPenalty = last === 0 ? 0
      : Math.max(0, 1 - hours / this.cfg.recentUsePenaltyHours);

    return w.propagation * prop
         + w.surveyQ * q
         + (w.regionPreference || 0) * regionBonus
         - w.mainsPenalty * mainsPenalty
         - w.adcOvPenalty * adcPenalty
         - w.recentUsePenalty * recentPenalty;
  }

  /**
   * @param {number} freqKHz
   * @param {{exclude?:Set<string>, when?:number, jitter?:number}} [opts]
   * @returns {object|null}
   */
  pick(freqKHz, opts) {
    opts = opts || {};
    const when = opts.when || Date.now();
    const exclude = opts.exclude || new Set();

    const cands = [];
    for (const r of this.receivers) {
      const k = this.key(r);
      if (exclude.has(k)) continue;
      if (!this.eligible(r, freqKHz)) continue;
      cands.push({ r, s: this.score(r, freqKHz, when) });
    }
    if (!cands.length) return null;

    cands.sort((a, b) => b.s - a.s);

    // Choose randomly among the top slice. A strictly-best pick would hammer
    // the same handful of receivers every rotation, which is precisely the
    // behaviour the recent-use penalty exists to avoid.
    const topN = Math.max(1, Math.min(cands.length, opts.jitter || this.cfg.pickTopN || 15));
    const chosen = cands[Math.floor(Math.random() * topN)];
    return Object.assign({}, chosen.r, { _score: chosen.s });
  }

  markUsed(r, when) {
    this.lastUsed.set(this.key(r), when || Date.now());
  }

  markFailure(r) {
    const k = this.key(r);
    const prev = this.failures.get(k);
    this.failures.set(k, { count: (prev ? prev.count : 0) + 1, at: Date.now() });
  }

  markSuccess(r) {
    this.failures.delete(this.key(r));
  }

  /**
   * Best propagation score achievable for this frequency right now, across
   * eligible receivers. Drives the propagation gate: if no receiver anywhere
   * in the pool has a plausibly-open path, the frequency is not worth a slot.
   */
  bestPropagation(freqKHz, when) {
    when = when || Date.now();
    let best = 0;
    for (const r of this.receivers) {
      if (!this.eligible(r, freqKHz)) continue;
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      const p = propagationScore(freqKHz, solarElevation(when, r.lat, r.lon));
      if (p > best) best = p;
    }
    return best;
  }

  /** Distinct region values present in the pool, for validating a preference. */
  regions() {
    const set = new Set();
    for (const r of this.receivers) if (r.region) set.add(r.region);
    return Array.from(set).sort();
  }

  stats(freqKHz) {
    let eligible = 0, cooling = 0;
    for (const r of this.receivers) {
      if (this.eligible(r, freqKHz)) eligible++;
      else if (this.failures.has(this.key(r))) cooling++;
    }
    return { total: this.receivers.length, eligible, cooling };
  }
}

module.exports = {
  SiteSelector, loadPool, loadBlocklist, findLatestScores,
  solarElevation, propagationScore, preferenceFor, parseBands
};
