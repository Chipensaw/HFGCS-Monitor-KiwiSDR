'use strict';
//
// index.js -- the HFGCS recorder.
//
// One process, one worker per active frequency. Each worker owns a frequency
// and rotates receivers underneath it.
//
// EVERYTHING SESSION-SCOPED LIVES ON A SESSION CONTEXT
// ----------------------------------------------------
// The first version hung the ring, detector and in-flight capture directly on
// the worker. During a make-before-break rotation two sessions are briefly
// alive at once, and the incoming session's detector could adopt the outgoing
// session's half-written capture file. Each session now carries its own ctx
// {sess, rx, ring, det, capture} and handlers close over it, so a session can
// only ever finish its own work.
//
// ROTATION IS MAKE-BEFORE-BREAK
// -----------------------------
// A worker opens its next receiver, waits for audio to actually flow, and only
// then drops the old one. The brief two-slot overlap is across DIFFERENT
// receivers, so no single sysop sees us holding two. Break-before-make would
// put a reconnect-shaped hole in coverage on every rotation.
//
// ROTATION DEFERS TO AN ACTIVE TRANSMISSION
// -----------------------------------------
// If the detector is mid-event when the rotation timer fires, the swap waits
// (up to a cap). Cutting an EAM in half to satisfy a timer is a self-inflicted
// wound.
//
// CAPTURES STREAM TO DISK
// -----------------------
// On trigger the worker opens a WAV and seeds it with pre-roll from the ring;
// audio then streams straight to the file. The ring is responsible for
// pre-roll ONLY. Extracting a finished event from the ring instead capped
// event length at ring capacity and silently truncated a long EAM -- measured,
// not hypothesised.
//
// COVERAGE IS REPORTED, NOT IMPLIED
// ---------------------------------
// Rotation, slot contention and refusals mean transmissions are missed. Every
// second actually spent streaming is accounted and written out hourly.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const { KiwiAudioSession } = require('./kiwi-audio-client');
const { RingBuffer } = require('./ring-buffer');
const { Store, safeSite, stamp, utcDay } = require('./store');
const { WavStreamWriter } = require('./encoder');
const { VoiceDetector } = require('../detector/voice-detector');
const { analyseBuffer } = require('../detector/features');
const { renderFileWith } = require('./spectrogram');
const { SiteSelector, loadPool, loadBlocklist } = require('../scheduler/select');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    if (m) out[m[1]] = m[2] === '' ? true : m[2];
  }
  return out;
}

// The installed unit passes --scores-glob=<root>/run-*/scores.json; the
// selector wants the root. Accept either rather than fail on a path shape.
function surveyRootFrom(args) {
  if (args['survey-data']) return args['survey-data'];
  const g = args['scores-glob'];
  if (typeof g === 'string') {
    const i = g.indexOf('/run-');
    if (i > 0) return g.slice(0, i);
    return path.dirname(path.dirname(g));
  }
  return null;
}

/**
 * Cheap liveness check before spending a WebSocket handshake on a host.
 *
 * Roughly 10% of any cohort snapshot is dead at a given moment -- the survey's
 * final sweep logged 17 of 200 unreachable. Without this, each dead host cost a
 * full connect timeout and the worker could sit for minutes without ever
 * reaching a live receiver.
 *
 * Deliberately does NOT force an address family. Node's Happy Eyeballs will try
 * both; an IPv6-only host with no route here simply fails fast and gets marked,
 * which is the correct outcome.
 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve(ok);
    };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function log(level, msg, extra) {
  const line = '[' + new Date().toISOString() + '] ' + level + ' ' + msg +
               (extra ? ' ' + JSON.stringify(extra) : '');
  if (level === 'ERROR') console.error(line); else console.log(line);
}

class ChannelWorker extends EventEmitter {
  constructor(freq, deps, cfg) {
    super();
    this.freqKHz = freq.khz;
    this.selector = deps.selector;
    this.store = deps.store;
    this.sessionFactory = deps.sessionFactory ||
      ((rx, khz, o) => new KiwiAudioSession(rx, khz, o));
    this.cfg = cfg;

    this.running = false;
    this.current = null;      // ctx that is streaming
    this.pending = null;      // ctx that is opening

    this.rotateTimer = null;
    this.retryTimer = null;
    this.parkTimer = null;
    this.rotateDue = 0;
    this.backoffIndex = 0;
    this.pendingWrites = 0;

    this.stats = {
      freqKHz: this.freqKHz,
      sessions: 0, rotations: 0, refusals: 0, failures: 0, parks: 0, probeFailures: 0,
      events: 0, kept: 0, discarded: 0,
      streamingMs: 0, lastSite: null, state: 'stopped'
    };
    this._streamStart = 0;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    Promise.resolve(this._connect()).catch((e) =>
      log('ERROR', 'ch' + this.freqKHz + ' connect threw: ' + e.message));
    return this;
  }

  async stop(reason) {
    this.running = false;
    for (const t of [this.rotateTimer, this.retryTimer, this.parkTimer]) if (t) clearTimeout(t);
    this.rotateTimer = this.retryTimer = this.parkTimer = null;
    this._accrue();

    for (const ctx of [this.pending, this.current]) {
      if (!ctx) continue;
      ctx.retired = true;
      if (ctx.det) ctx.det.flush(reason || 'shutdown');
      this._abortCapture(ctx);
      try { ctx.sess.close('shutdown'); } catch (_) {}
    }
    this.current = this.pending = null;
    this.stats.state = 'stopped';

    const deadline = Date.now() + 10000;
    while (this.pendingWrites > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  _accrue() {
    if (this._streamStart) {
      this.stats.streamingMs += Date.now() - this._streamStart;
      this._streamStart = 0;
    }
  }

  _backoffMs() {
    const b = this.cfg.session.reconnectBackoffMs;
    const ms = b[Math.min(this.backoffIndex, b.length - 1)];
    this.backoffIndex++;
    return ms;
  }

  _retryLater() {
    if (!this.running || this.pending || this.current) return;
    const ms = this._backoffMs();
    this.stats.state = 'backoff';
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running && !this.pending && !this.current) {
        Promise.resolve(this._connect()).catch((e) =>
          log('ERROR', 'ch' + this.freqKHz + ' connect threw: ' + e.message));
      }
    }, ms);
  }

  /**
   * Is this frequency worth a slot right now?
   *
   * Holding 4724 kHz through local noon consumes a volunteer's receiver to
   * listen to a dead band. The gate asks whether ANY eligible receiver in the
   * pool has a plausibly open path; if not, the worker releases its slot and
   * sleeps until the band reopens.
   *
   * 24H frequencies (8992, 11175) score flat and never gate closed.
   */
  _gate(when) {
    const g = this.cfg.propagationGate;
    if (!g || !g.enabled) return { open: true, score: 1, threshold: 0, reason: null };

    // An empty eligible pool is NOT a closed band. bestPropagation returns 0
    // either way, and conflating them made a drained pool look like a
    // propagation decision and park the channel silently.
    const st = this.selector.stats(this.freqKHz);
    if (st.eligible === 0) {
      return { open: false, score: 0, threshold: g.minScore,
               reason: 'no eligible receivers (' + st.cooling + ' cooling down)' };
    }
    const score = this.selector.bestPropagation(this.freqKHz, when);
    return { open: score >= g.minScore, score, threshold: g.minScore,
             reason: score >= g.minScore ? null : 'band closed' };
  }

  _park(gate) {
    // Release the slot -- parking that kept the connection open would defeat
    // the entire point.
    if (this.current) {
      const ctx = this.current;
      ctx.retired = true;
      if (ctx.det) ctx.det.flush('band_closed');
      this._abortCapture(ctx);
      try { ctx.sess.close('band_closed'); } catch (_) {}
      this._accrue();
      this.current = null;
    }
    if (this.rotateTimer) { clearTimeout(this.rotateTimer); this.rotateTimer = null; }
    this.rotateDue = 0;

    this.stats.state = 'parked';
    this.stats.parks++;
    const mins = (this.cfg.propagationGate && this.cfg.propagationGate.recheckMinutes) || 15;
    log('INFO', 'ch' + this.freqKHz + ' parked: ' + (gate.reason || 'band closed') +
        ' (best path ' + gate.score.toFixed(2) + ' < ' + gate.threshold + '), recheck in ' + mins + ' min');

    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = setTimeout(() => {
      this.parkTimer = null;
      if (this.running) {
        Promise.resolve(this._connect()).catch((e) =>
          log('ERROR', 'ch' + this.freqKHz + ' connect threw: ' + e.message));
      }
    }, mins * 60000);
  }

  async _connect(excludeKey) {
    if (!this.running || this.pending) return;

    const gate = this._gate();
    if (!gate.open) return this._park(gate);

    if (!this.current) this.stats.state = 'selecting';

    const exclude = new Set();
    if (excludeKey) exclude.add(excludeKey);
    if (this.current) exclude.add(this.current.key);

    // Probe candidates until one answers. A dead host costs ~probeMs instead of
    // a full WebSocket handshake timeout, so a run of stale cohort entries no
    // longer strands the channel.
    const probeMs = this.cfg.session.probeTimeoutMs || 2500;
    const maxTries = this.cfg.session.maxProbeAttempts || 6;
    let rx = null;

    for (let i = 0; i < maxTries; i++) {
      if (!this.running || this.pending) return;
      const cand = this.selector.pick(this.freqKHz, { exclude });
      if (!cand) break;
      const ck = this.selector.key(cand);
      exclude.add(ck);

      const alive = await tcpProbe(cand.host, cand.port, probeMs);
      if (!this.running) return;
      if (alive) { rx = cand; break; }

      this.stats.probeFailures++;
      this.selector.markFailure(cand);
      log('INFO', 'ch' + this.freqKHz + ' ' + ck + ' unreachable, skipping');
    }

    if (!rx) {
      log('WARN', 'ch' + this.freqKHz + ' no reachable receiver after ' + maxTries + ' probes');
      // Same stall as a failed rotation target: _retryLater() does nothing
      // while a session is current, so without this the rotation timer is
      // never re-armed and the worker holds its receiver indefinitely.
      if (this.current) {
        this._armRotation(this.cfg.session.rotateRetryMinutes);
        return;
      }
      return this._retryLater();
    }

    const key = this.selector.key(rx);
    const sampleRate = this.cfg.receiver.outputSampleRate;

    let sess;
    try {
      sess = this.sessionFactory(rx, this.freqKHz, {
        identUser: this.cfg.identification.kiwiIdentUser,
        // Only forward it if set. Object.assign copies undefined, so passing
        // an absent key here would CLOBBER the client's default rather than
        // fall back to it -- and an undefined HTTP header then breaks the
        // WebSocket upgrade outright. Same trap as the detector config.
        ...(this.cfg.identification.userAgent
            ? { userAgent: this.cfg.identification.userAgent } : {}),
        mode: this.cfg.mode || 'usb',
        lowCut: this.cfg.receiver.passbandHz[0],
        highCut: this.cfg.receiver.passbandHz[1],
        agc: this.cfg.agc,
        // Everything else in `receiver` passes straight through, so a new
        // client option does not need a line added here to take effect. A
        // hand-maintained list already silently swallowed three detector
        // settings once; this is the same shape of bug waiting to happen.
        ...Object.fromEntries(Object.entries(this.cfg.receiver).filter(
          ([k, v]) => v !== undefined && !k.startsWith('_') &&
                      k !== 'passbandHz' && k !== 'outputSampleRate' &&
                      k !== 'agcDecayMs'))
      });
    } catch (e) {
      log('ERROR', 'ch' + this.freqKHz + ' session construction failed: ' + e.message);
      if (this.current) { this._armRotation(this.cfg.session.rotateRetryMinutes); return; }
      return this._retryLater();
    }

    const ctx = {
      sess, rx, key, sampleRate,
      ring: RingBuffer.forSeconds(this.cfg.ringBuffer.seconds, sampleRate),
      det: new VoiceDetector(Object.assign({ sampleRate }, this.cfg.detector)),
      capture: null, live: false, retired: false
    };

    this.pending = ctx;
    if (!this.current) this.stats.state = 'connecting';
    log('INFO', 'ch' + this.freqKHz + ' -> ' + key,
        { score: Number(rx._score || 0).toFixed(3) });

    this._wire(ctx);
    try {
      sess.open();
    } catch (e) {
      log('ERROR', 'ch' + this.freqKHz + ' open failed: ' + e.message);
      this.pending = null;
      if (this.current) this._armRotation(this.cfg.session.rotateRetryMinutes);
      else this._retryLater();
    }
  }

  _wire(ctx) {
    const { sess, det, ring, rx } = ctx;

    sess.on('ready', () => {
      if (ctx.retired) return;
      ctx.live = true;
      ctx.liveAt = Date.now();
      this.selector.markUsed(rx);
      this.selector.markSuccess(rx);
      this.backoffIndex = 0;
      this.stats.sessions++;
      this.stats.lastSite = ctx.key;

      // Retire the outgoing session only now that this one is actually flowing.
      const old = this.current;
      if (old && old !== ctx) {
        old.retired = true;
        if (old.det) old.det.flush('rotated');
        this._abortCapture(old);
        try { old.sess.close('rotated'); } catch (_) {}
      }

      this._accrue();               // close out the previous streaming span
      this.current = ctx;
      this.pending = null;
      this.stats.state = 'streaming';
      this._streamStart = Date.now();

      this._armRotation();
      log('INFO', 'ch' + this.freqKHz + ' streaming from ' + ctx.key);
    });

    sess.on('audio', (pcm) => {
      if (!ctx.live || ctx.retired) return;
      const startAbs = ring.written;
      ring.write(pcm);
      det.process(pcm, startAbs);      // may fire 'trigger' synchronously

      // A trigger raised inside det.process() already flushed the ring through
      // the end of THIS chunk, so only append later chunks.
      const cap = ctx.capture;
      if (cap && cap.dumpedThroughAbs <= startAbs) {
        cap.writer.write(pcm);
        cap.lastAbs = startAbs + pcm.length;
      }
    });

    det.on('trigger', (t) => {
      if (!ctx.retired) this._beginCapture(ctx, t);
    });

    det.on('release', (ev) => {
      this.stats.events++;
      this._finishCapture(ctx, ev);
    });

    sess.on('error', (e) => {
      if (e.code === 'ip_limit' || e.code === 'too_busy') {
        this.stats.refusals++;
        this.selector.markUsed(rx);      // do not come straight back
      } else {
        this.stats.failures++;
        this.selector.markFailure(rx);
      }
      log('WARN', 'ch' + this.freqKHz + ' ' + ctx.key + ' ' + e.code + ': ' + e.message);
    });

    sess.on('close', () => {
      if (ctx.retired) return;           // an outgoing session closing is normal
      ctx.retired = true;

      if (ctx === this.pending) {
        // Died before it ever streamed. This MUST still trigger a retry or the
        // worker waits forever for a 'ready' that is never coming -- which is
        // exactly how a refusing receiver used to wedge a channel.
        this.pending = null;
        if (!this.current) {
          this._retryLater();
        } else {
          // A ROTATION attempt failed. The old session is still streaming, so
          // there is nothing to recover -- but the rotation timer has already
          // fired and nothing else will re-arm it. Observed live: a rotation
          // target hit ready_timeout and the channel then held one receiver
          // for 124 minutes against a 22 minute cap, which is exactly the
          // discourtesy the rotation exists to prevent.
          log('WARN', 'ch' + this.freqKHz + ' rotation target failed, re-arming');
          this._armRotation(this.cfg.session.rotateRetryMinutes);
        }
        return;
      }
      if (ctx === this.current) {
        this._accrue();
        if (ctx.det) ctx.det.flush('session_closed');
        this._abortCapture(ctx);
        this.current = null;
        if (this.rotateTimer) { clearTimeout(this.rotateTimer); this.rotateTimer = null; }
        this._retryLater();
      }
    });
  }

  _beginCapture(ctx, t) {
    if (ctx.capture) return;               // continuation of a max_length split
    const sampleRate = ctx.sampleRate;
    const pre = Math.round(this.cfg.ringBuffer.preRollSeconds * sampleRate);
    const av = ctx.ring.available();
    const from = Math.max(av.from, t.startAbs - pre);

    const shortfall = Math.max(0, from - (t.startAbs - pre));
    if (shortfall > 0) {
      log('WARN', 'ch' + this.freqKHz + ' pre-roll short by ' +
          (shortfall / sampleRate).toFixed(2) + 's (ring lapped)');
    }

    let preRoll;
    try {
      preRoll = ctx.ring.read(from, av.to);
    } catch (e) {
      log('ERROR', 'ch' + this.freqKHz + ' pre-roll read failed: ' + e.message);
      preRoll = new Int16Array(0);
    }

    const when = Date.now() - ((av.to - from) / sampleRate) * 1000;
    const base = stamp(when) + '_' + this.freqKHz + '_' + safeSite(ctx.key);
    let writer;
    try {
      const dir = this.store.dayDir(when);
      writer = new WavStreamWriter(path.join(dir, base + '.wav'), sampleRate);
    } catch (e) {
      log('ERROR', 'ch' + this.freqKHz + ' cannot open capture: ' + e.message);
      return;
    }
    writer.write(preRoll);

    ctx.capture = {
      writer, base, when,
      firstAbs: from,
      dumpedThroughAbs: av.to,
      lastAbs: av.to,
      preRollSec: Math.max(0, (t.startAbs - from) / sampleRate),
      preRollShortSec: shortfall / sampleRate
    };
  }

  _abortCapture(ctx) {
    if (ctx && ctx.capture) {
      try { ctx.capture.writer.abort(); } catch (_) {}
      ctx.capture = null;
    }
  }

  /**
   * Re-read a finished capture and compute its full feature vector.
   *
   * Deliberately measured FROM THE FILE rather than accumulated during the
   * event, so the numbers in events.jsonl are byte-identical to what offline
   * analysis produces. Thresholds can then be re-fitted against recorded data
   * instead of re-recording every time we change our minds about a feature --
   * which is what today's uncalibrated run cost us.
   */
  _featuresOf(file, sampleRate) {
    try {
      const b = fs.readFileSync(file);
      let pos = 12, data = null;
      while (pos + 8 <= b.length) {
        const id = b.toString('latin1', pos, pos + 4);
        const size = b.readUInt32LE(pos + 4);
        if (id === 'data') { data = b.subarray(pos + 8, pos + 8 + size); break; }
        pos += 8 + size + (size % 2);
      }
      if (!data) return null;
      const n = data.length >> 1;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = data.readInt16LE(i * 2);
      const a = analyseBuffer(pcm, { sampleRate });
      return {
        flatDipFraction: Number(a.flatDipFraction.toFixed(4)),
        flatnessP10: Number(a.flatnessP10.toFixed(4)),
        medianFlatness: Number(a.medianFlatness.toFixed(4)),
        harmonicityP90: Number(a.harmonicityP90.toFixed(4)),
        harmonicVoicedFraction: Number(a.harmonicVoicedFraction.toFixed(4)),
        medianHarmonicity: Number(a.medianHarmonicity.toFixed(4)),
        medianModFraction: Number(a.medianModFraction.toFixed(4))
      };
    } catch (e) {
      log('WARN', 'ch' + this.freqKHz + ' feature extraction failed: ' + e.message);
      return null;
    }
  }

  _finishCapture(ctx, ev) {
    const cap = ctx.capture;
    ctx.capture = null;
    if (!cap) { if (!ev.kept) this.stats.discarded++; return; }

    const sampleRate = ctx.sampleRate;
    const wanted = Math.max(0, ev.endAbs - cap.firstAbs);
    let res;
    try {
      res = cap.writer.close(wanted);
    } catch (e) {
      log('ERROR', 'ch' + this.freqKHz + ' capture close failed: ' + e.message);
      try { cap.writer.abort(); } catch (_) {}
      return;
    }

    if (!ev.kept) {
      this.stats.discarded++;
      try { fs.unlinkSync(res.path); } catch (_) {}
      return;
    }

    const durationSec = res.samples / sampleRate;
    // Waterfall rows overlapping this capture, pre-roll included.
    const wfFrom = Date.now() - (ev.durationSec * 1000) - 2000;
    const wf = (ctx.sess && typeof ctx.sess.waterfallRows === 'function')
      ? ctx.sess.waterfallRows(wfFrom, Date.now())
      : null;
    const thumb = renderFileWith(res.path, wf);

    const record = {
      freqKHz: this.freqKHz,
      site: ctx.key,
      siteId: ctx.rx.id || null,
      lat: Number.isFinite(ctx.rx.lat) ? ctx.rx.lat : null,
      lon: Number.isFinite(ctx.rx.lon) ? ctx.rx.lon : null,
      startedAt: new Date(cap.when).toISOString(),
      day: utcDay(cap.when),
      id: cap.base,
      file: path.basename(res.path),
      codec: res.codec,
      bytes: res.bytes,
      samples: res.samples,
      sampleRate,
      durationSec: Number(durationSec.toFixed(2)),
      preRollSec: Number(cap.preRollSec.toFixed(2)),
      preRollShortSec: Number(cap.preRollShortSec.toFixed(2)),
      peakModFraction: Number(ev.peakModFraction.toFixed(4)),
      meanModFraction: Number(ev.meanModFraction.toFixed(4)),
      // What the GATE tested, so a row can be compared directly against
      // minVoicedFraction. The whole-file figure in `features` is a
      // different quantity and reads much lower.
      voicedAtTrigger: ev.voicedAtTrigger != null
        ? Number(ev.voicedAtTrigger.toFixed(4)) : null,
      peakVoicedFraction: ev.peakVoicedFraction != null
        ? Number(ev.peakVoicedFraction.toFixed(4)) : null,
      floorAtTrigger: Number(ev.floorAtTrigger.toFixed(4)),
      thresholdAtTrigger: Number(ev.thresholdAtTrigger.toFixed(4)),
      closeReason: ev.reason,
      provisionalThresholds: true,    // until Phase 1 calibration lands
      // Full feature vector for offline threshold fitting. modFraction is
      // retained but is known NOT to separate on real HF: measured static
      // reaches 0.703 against a real EAM's 0.712.
      features: this._featuresOf(res.path, sampleRate),
      // Waterfall thumbnail. Prefer real RF spectrum from the receiver's W/F
      // socket -- typically 29 kHz across, so the signal sits in context -- and
      // fall back to an audio spectrogram, which can never exceed 6 kHz.
      thumb: thumb ? thumb.file : null,
      thumbSource: thumb ? thumb.source : null
    };

    this.pendingWrites++;
    try {
      this.store.appendRecord(record);
      this.stats.kept++;
      log('INFO', 'ch' + this.freqKHz + ' captured ' + record.durationSec +
          's -> ' + record.file, { peak: record.peakModFraction });
    } catch (e) {
      log('ERROR', 'ch' + this.freqKHz + ' record append failed: ' + e.message);
    } finally {
      this.pendingWrites--;
    }
  }

  /** @param {number} [overrideMinutes] retry sooner after a failed rotation */
  _armRotation(overrideMinutes) {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    const s = this.cfg.session;
    let mins;
    if (overrideMinutes != null) {
      mins = overrideMinutes;
    } else {
      const jitter = (Math.random() * 2 - 1) * (s.jitterMinutes || 0);
      const floor = s.minMinutes != null ? s.minMinutes : 1;
      mins = Math.max(floor, s.maxMinutes + jitter);
    }
    this.rotateDue = Date.now() + mins * 60000;
    this.rotateTimer = setTimeout(() => this._rotate(0), mins * 60000);
  }

  _rotate(waited) {
    if (!this.running || !this.current || this.pending) return;

    if (this.current.det && this.current.det.state === 'active') {
      const cap = (this.cfg.session.rotateDeferMaxSec || 180) * 1000;
      if (waited < cap) {
        this.rotateTimer = setTimeout(() => this._rotate(waited + 5000), 5000);
        return;
      }
      log('WARN', 'ch' + this.freqKHz + ' rotating despite active event (deferral cap)');
    }

    // The band may have closed since this session started; rotation is the
    // natural point to notice.
    const gate = this._gate();
    if (!gate.open) return this._park(gate);

    this.stats.rotations++;
    log('INFO', 'ch' + this.freqKHz + ' rotating away from ' + this.current.key);
    Promise.resolve(this._connect(this.current.key)).catch((e) =>
      log('ERROR', 'ch' + this.freqKHz + ' rotate connect threw: ' + e.message));
  }

  snapshot() {
    const det = this.current ? this.current.det : null;
    const m = det ? det.metrics() : null;
    return Object.assign({}, this.stats, {
      streamingMsLive: this.stats.streamingMs +
        (this._streamStart ? Date.now() - this._streamStart : 0),
      rotateInSec: this.rotateDue
        ? Math.max(0, Math.round((this.rotateDue - Date.now()) / 1000)) : null,
      capturing: !!(this.current && this.current.capture),
      // lastSite is history; connectedSite is truth. Showing the former as
      // though it were the latter makes a parked or backed-off channel look
      // like it is still listening to a receiver it released minutes ago.
      connectedSite: this.current ? this.current.key : null,
      connectedSinceSec: (this.current && this.current.liveAt)
        ? Math.round((Date.now() - this.current.liveAt) / 1000) : null,
      propagation: Number(this._gate().score.toFixed(3)),
      gateOpen: this._gate().open,
      parkReason: this._gate().reason,
      eligibleReceivers: this.selector.stats(this.freqKHz).eligible,
      parkRecheckMin: (this.cfg.propagationGate && this.cfg.propagationGate.recheckMinutes) || null,
      detector: m ? {
        state: m.state, warm: m.warm,
        modFraction: Number(m.modFraction.toFixed(4)),
        flatness: Number(m.flatness.toFixed(4)),
        floor: Number(m.floor.toFixed(4)),
        threshold: Number(m.threshold.toFixed(4))
      } : null
    });
  }
}

class Recorder {
  constructor(opts) {
    this.cfg = opts.cfg;
    this.store = opts.store;
    this.selector = opts.selector;
    this.sessionFactory = opts.sessionFactory;
    this.workers = [];
    this.timers = [];
    this.startedAt = Date.now();
    this._coverageMark = Date.now();
  }

  start() {
    const active = (this.cfg.frequencies || []).filter((f) => f.active);
    if (!active.length) throw new Error('no active frequencies in config');
    log('INFO', 'starting ' + active.length + ' channel(s): ' +
        active.map((f) => f.khz).join(', '));

    for (const f of active) {
      const w = new ChannelWorker(f, {
        selector: this.selector, store: this.store,
        sessionFactory: this.sessionFactory
      }, this.cfg);
      this.workers.push(w);
      w.start();
    }
    this.timers.push(setInterval(() => this._status(), 5000));
    this.timers.push(setInterval(() => this._coverage(), 3600000));
    this._status();
    return this;
  }

  _status() {
    try {
      this.store.writeStatus({
        pid: process.pid,
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        provisionalThresholds: true,
        channels: this.workers.map((w) => w.snapshot())
      });
    } catch (e) {
      log('ERROR', 'status write failed: ' + e.message);
    }
  }

  _coverage() {
    const now = Date.now();
    const windowMs = now - this._coverageMark;
    for (const w of this.workers) {
      const live = w.snapshot().streamingMsLive;
      const prev = w._coveragePrev || 0;
      const delta = Math.max(0, live - prev);
      w._coveragePrev = live;
      this.store.appendCoverage({
        freqKHz: w.freqKHz,
        windowSec: Math.round(windowMs / 1000),
        monitoredSec: Math.round(delta / 1000),
        fraction: windowMs ? Number((delta / windowMs).toFixed(4)) : 0,
        sessions: w.stats.sessions,
        refusals: w.stats.refusals,
        kept: w.stats.kept
      });
    }
    this._coverageMark = now;
  }

  async stop(reason) {
    log('INFO', 'stopping: ' + reason);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all(this.workers.map((w) => w.stop(reason)));
    this._coverage();
    this._status();
  }
}

function buildConfig(raw) {
  const d = raw.detector || {};
  return {
    frequencies: raw.frequencies || [],
    mode: (raw.frequencies && raw.frequencies[0] && raw.frequencies[0].mode) || 'usb',
    receiver: Object.assign({ outputSampleRate: 12000, passbandHz: [300, 2800] }, raw.receiver),
    agc: {
      enabled: 1, hang: 0, threshDb: -90, slopeDb: 6,
      decayMs: (raw.receiver && raw.receiver.agcDecayMs) || 2000, gainDb: 50
    },
    session: Object.assign({
      maxMinutes: 22, jitterMinutes: 4, minMinutes: 1,
      // How soon to retry after a rotation TARGET fails. Short: the point is
      // to stop holding the current receiver past its cap.
      rotateRetryMinutes: 2,
      reconnectBackoffMs: [5000, 15000, 60000, 300000],
      rotateDeferMaxSec: 180,
      probeTimeoutMs: 2500, maxProbeAttempts: 6
    }, raw.session),
    ringBuffer: Object.assign({ seconds: 60, preRollSeconds: 10 }, raw.ringBuffer),
    propagationGate: Object.assign(
      { enabled: true, minScore: 0.35, recheckMinutes: 15 }, raw.propagationGate),
    identification: Object.assign({ kiwiIdentUser: 'hfgcs-recorder' }, raw.identification),
    // Forward EVERY detector key, not a hand-maintained list.
    //
    // This was a whitelist of 11 names. Three settings added later --
    // minVoicedFraction, harmVoicedThreshold, trailingSeconds -- were read from
    // the config, shown in the settings page, and saved correctly, then
    // silently dropped here. The detector kept its code defaults and the
    // operator's setting did nothing at all, across several restarts, with no
    // error anywhere.
    //
    // A whitelist that must be updated whenever a setting is added will
    // eventually not be. Only the two deliberate renames are special-cased;
    // everything else passes through, and undefined values are omitted so they
    // cannot clobber a default.
    detector: (() => {
      const RENAMED = { frameSamples: 'fftSize', hopSamples: 'hop' };
      const out = {};
      for (const [k, v] of Object.entries(d)) {
        if (k.startsWith('_') || v === undefined) continue;
        out[RENAMED[k] || k] = v;
      }
      return out;
    })(),
    output: Object.assign({ codec: 'wav', bitrateKbps: 24 }, raw.output),
    siteSelection: raw.siteSelection || {}
  };
}

function main() {
  const args = parseArgs(process.argv);
  const cfgPath = args.config || '/opt/hfgcs/config/hfgcs.json';
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const cfg = buildConfig(raw);

  const dataRoot = args.data || '/opt/hfgcs/data';
  const cohort = args.cohort || '/opt/kiwi-survey/generator/cohort.json';
  const blocklist = loadBlocklist(args.blocklist || '/opt/hfgcs/config/blocklist.txt');
  const pool = loadPool(cohort, surveyRootFrom(args));

  log('INFO', 'pool loaded', {
    receivers: pool.receivers.length,
    scores: pool.scoresPath || 'none',
    blocked: blocklist.size
  });

  const selector = new SiteSelector(pool, Object.assign({ blocklist }, cfg.siteSelection));
  for (const f of cfg.frequencies.filter((x) => x.active)) {
    const s = selector.stats(f.khz);
    log('INFO', 'ch' + f.khz + ' eligible receivers: ' + s.eligible + '/' + s.total);
  }

  const store = new Store(dataRoot, {
    codec: cfg.output.codec, bitrateKbps: cfg.output.bitrateKbps
  });
  const rec = new Recorder({ cfg, store, selector }).start();

  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    rec.stop(sig).then(() => process.exit(0)).catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 20000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = { Recorder, ChannelWorker, buildConfig, parseArgs, surveyRootFrom, tcpProbe };
