'use strict';
//
// config-ui.js -- read/validate/write hfgcs.json from the web page.
//
// The schema below is the single source of truth: it drives validation AND
// generates the form, so a field cannot exist in one and not the other.
//
// WHY SOME FIELDS CARRY A "measured" NOTE
// ---------------------------------------
// A few numbers here came from measurement against a real 146 s USAF EAM
// capture, not from taste. Those carry their provenance into the UI so the
// reason is in front of whoever changes them, rather than buried in a file.
// They are editable -- this is an operator's instrument, not a museum -- but
// the measurement travels with the field.
//
// agcDecayMs is the one hard floor. A 100 ms AGC is a ~1.6 Hz corner on the
// audio envelope and notches the exact 0.2-3 Hz band the detector lives in;
// measured, it destroyed 75% of the discriminator (73.7% -> 18.8%). The
// recorder's Kiwi client THROWS on a value below 1000, so accepting one here
// would just move the failure to a place with a worse error message.
//
// ENABLE/DISABLE IS NOT HERE, BY DESIGN
// -------------------------------------
// config/ENABLED stays a shell act. It is the authorisation to contact other
// people's receivers, and a web form should not be able to grant it.

const fs = require('fs');
const path = require('path');

const AGC_DECAY_MS_MIN = 1000;

/**
 * Each entry: dotted path into hfgcs.json.
 *   type   'int' | 'float' | 'bool' | 'enum'
 *   min/max  inclusive bounds, rejected outside
 *   measured  provenance string shown under the field
 */
const SCHEMA = [
  { group: 'Detector', key: 'detector.modFractionAbsMin', type: 'float', min: 0.01, max: 0.99,
    label: 'Modulation floor (absolute)',
    help: 'Minimum 0.2-3 Hz envelope-modulation fraction to trigger.',
    measured: 'PROVISIONAL. Real EAM measured 0.737; white noise 0.126. Not yet calibrated against real empty channel.' },

  { group: 'Detector', key: 'detector.modFractionRatioOverFloor', type: 'float', min: 1.0, max: 20.0,
    label: 'Modulation floor (x rolling floor)',
    help: 'Also require this multiple of the per-channel rolling floor.',
    measured: 'PROVISIONAL. Raising this cuts false positives and misses weak signals.' },

  { group: 'Detector', key: 'detector.flatnessRejectBelow', type: 'float', min: 0.0, max: 1.0,
    label: 'Carrier reject below flatness',
    help: 'Spectral flatness under this is a carrier or birdie, not speech.',
    measured: 'Measured: carrier 0.071, speech 0.368, noise 0.562. 0.15 sits in the gap.' },

  { group: 'Detector', key: 'detector.hangoverSeconds', type: 'float', min: 0.5, max: 30,
    label: 'Hangover (s)', help: 'Silence tolerated before an event closes.' },
  { group: 'Detector', key: 'detector.minEventSeconds', type: 'float', min: 0.5, max: 120,
    label: 'Minimum event (s)', help: 'Shorter captures are discarded.' },
  { group: 'Detector', key: 'detector.maxEventSeconds', type: 'int', min: 10, max: 3600,
    label: 'Maximum event (s)', help: 'Longer events split and re-arm; nothing is lost.' },
  { group: 'Detector', key: 'detector.floorPercentile', type: 'int', min: 1, max: 99,
    label: 'Floor percentile', help: 'Percentile of quiet-time modulation used as the rolling floor.' },
  { group: 'Detector', key: 'detector.floorWindowMinutes', type: 'int', min: 1, max: 240,
    label: 'Floor window (min)', help: 'How far back the rolling floor looks.' },

  { group: 'Receiver', key: 'receiver.agcDecayMs', type: 'int', min: AGC_DECAY_MS_MIN, max: 10000,
    label: 'AGC decay (ms)',
    help: 'Sent to the Kiwi as SET agc=... decay=<ms>.',
    measured: 'HARD FLOOR 1000. Measured: 2000ms scores 74.5%, 100ms collapses to 18.8% -- a fast AGC notches the detector band.' },

  { group: 'Session', key: 'session.maxMinutes', type: 'float', min: 1, max: 120,
    label: 'Session length (min)', help: 'How long to hold one receiver before rotating.' },
  { group: 'Session', key: 'session.jitterMinutes', type: 'float', min: 0, max: 30,
    label: 'Rotation jitter (min)', help: 'Randomises rotation so channels never rotate in lockstep.' },
  { group: 'Session', key: 'session.rotateDeferMaxSec', type: 'int', min: 0, max: 900,
    label: 'Rotation deferral cap (s)', help: 'Wait this long for an in-progress transmission before rotating anyway.' },

  { group: 'Propagation gate', key: 'propagationGate.enabled', type: 'bool',
    label: 'Gate enabled',
    help: 'Release the slot when no receiver has a plausible path.' },
  { group: 'Propagation gate', key: 'propagationGate.minScore', type: 'float', min: 0, max: 1,
    label: 'Minimum path score',
    help: '0.35 opens night bands below +3.5deg solar elevation, the day band above -3.5deg.' },
  { group: 'Propagation gate', key: 'propagationGate.recheckMinutes', type: 'int', min: 1, max: 240,
    label: 'Recheck interval (min)', help: 'How often a parked channel re-tests the band.' },

  { group: 'Buffer', key: 'ringBuffer.seconds', type: 'int', min: 10, max: 300,
    label: 'Ring buffer (s)',
    help: 'Only holds pre-roll; captures stream to disk, so this does not cap event length.' },
  { group: 'Buffer', key: 'ringBuffer.preRollSeconds', type: 'float', min: 0, max: 60,
    label: 'Pre-roll (s)',
    measured: 'Trigger-on-detect loses the first syllable of every transmission.',
    help: 'Audio kept from before the trigger.' },

  { group: 'Site selection', key: 'siteSelection.minUsersMax', type: 'int', min: 1, max: 8,
    label: 'Minimum receiver slots',
    help: 'Skip receivers with fewer total slots. Taking 1 of 2 is half the capacity of that receiver.' },
  { group: 'Site selection', key: 'siteSelection.preferRegions', type: 'csv',
    values: ['NA-East','NA-West','Europe-WC','Nordic-Baltic','Asia-East',
             'Oceania','ME-AsiaW','Atlantic-SA','Africa-Med'],
    label: 'Prefer receiver regions',
    help: 'Comma-separated. Blank = no preference.',
    measured: 'HFGCS ground stations are fixed (Andrews, Offutt, Puerto Rico, Elmendorf, Hickam, Croughton, Guam, Yokota, Diego Garcia, Lajes, Ascension). A receiver in Brazil at 23S hears few of them, so silence there may mean wrong place rather than no traffic. Measured: setting NA-East,NA-West took North American selection from 26% to 100%.' },

  { group: 'Site selection', key: 'siteSelection.allowProxied', type: 'bool',
    label: 'Allow proxied receivers',
    help: 'Proxied endpoints spend bandwidth donated to the community.' },

  { group: 'Output', key: 'output.codec', type: 'enum', values: ['wav', 'opus'],
    label: 'Capture format',
    help: 'opus falls back to wav automatically if ffmpeg is absent (it currently is).' },
  { group: 'Output', key: 'output.bitrateKbps', type: 'int', min: 8, max: 128,
    label: 'Opus bitrate (kbps)', help: 'Ignored when writing wav.' },

  { group: 'Identification', key: 'identification.kiwiIdentUser', type: 'text',
    maxLength: 32, pattern: '^[A-Za-z0-9._/-]+$',
    label: 'Identity sent to receivers',
    help: 'What a KiwiSDR sysop sees in their connection list.',
    measured: 'Goes on the wire in SET ident_user= and SERVER DE CLIENT <id> SND. Both are SPACE-DELIMITED, so spaces and control characters are rejected -- they would corrupt the protocol.' },

  { group: 'Retention', key: 'retention.retentionDays', type: 'int', min: 1, max: 3650,
    label: 'Keep for (days)' },
  { group: 'Retention', key: 'retention.maxTotalMB', type: 'int', min: 100, max: 102400,
    label: 'Disk cap (MB)', help: 'Whichever limit bites first wins.' }
];

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, dotted, val) {
  const parts = dotted.split('.');
  const last = parts.pop();
  let node = obj;
  for (const k of parts) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[last] = val;
}

function coerce(field, raw) {
  if (field.type === 'csv') {
    // Accept a comma-separated string from the form or an array from the API.
    const list = Array.isArray(raw)
      ? raw.slice()
      : String(raw == null ? '' : raw).split(',').map((v) => v.trim()).filter(Boolean);
    // Validate against the KNOWN region set. A typo would silently disable the
    // preference rather than error, which is the worst of both outcomes.
    const bad = list.filter((v) => field.values.indexOf(v) === -1);
    if (bad.length) {
      return { error: 'unknown region(s): ' + bad.join(', ') + '. Valid: ' + field.values.join(', ') };
    }
    return list;
  }
  if (field.type === 'text') {
    const v = String(raw == null ? '' : raw);
    if (!v.length) return { error: 'must not be empty' };
    if (field.maxLength && v.length > field.maxLength) {
      return { error: 'maximum ' + field.maxLength + ' characters' };
    }
    // Anything sent on the wire is validated against an ALLOW-list. This value
    // is interpolated into space-delimited protocol commands, so a space or a
    // newline would not merely look odd -- it would inject a second token and
    // corrupt the session setup.
    if (field.pattern && !new RegExp(field.pattern).test(v)) {
      return { error: 'only letters, digits and . _ - / (no spaces)' };
    }
    return v;
  }
  if (field.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '1' || raw === 1) return true;
    if (raw === 'false' || raw === '0' || raw === 0) return false;
    return { error: 'must be true or false' };
  }
  if (field.type === 'enum') {
    if (field.values.indexOf(raw) === -1) {
      return { error: 'must be one of ' + field.values.join(', ') };
    }
    return raw;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: 'must be a number' };
  if (field.type === 'int' && !Number.isInteger(n)) return { error: 'must be a whole number' };
  if (field.min != null && n < field.min) return { error: 'minimum is ' + field.min };
  if (field.max != null && n > field.max) return { error: 'maximum is ' + field.max };
  return n;
}

/**
 * Validate a flat {dottedKey: value} patch against SCHEMA.
 * Unknown keys are REJECTED rather than ignored -- silently dropping a setting
 * the operator believed they changed is worse than refusing it.
 */
function validate(patch) {
  const errors = {};
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const field = SCHEMA.find((f) => f.key === k);
    if (!field) { errors[k] = 'unknown setting'; continue; }
    const out = coerce(field, v);
    if (out && typeof out === 'object' && out.error) errors[k] = out.error;
    else clean[k] = out;
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

function validateFrequencies(list, current) {
  if (!Array.isArray(list)) return { ok: false, error: 'frequencies must be a list' };
  const known = new Set(current.map((f) => f.khz));
  for (const f of list) {
    if (!known.has(f.khz)) return { ok: false, error: 'unknown frequency ' + f.khz };
    if (typeof f.active !== 'boolean') return { ok: false, error: 'active must be boolean' };
  }
  return { ok: true };
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Backup, then write atomically. Never leaves a partial file for the recorder. */
function writeConfig(file, cfg, backupDir) {
  if (backupDir) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
      fs.copyFileSync(file, path.join(backupDir, path.basename(file) + '.' + stamp));
    } catch (e) { /* a failed backup must not block a valid change */ }
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

/** Current values + schema, for rendering the form. */
function describe(file) {
  const cfg = readConfig(file);
  return {
    frequencies: (cfg.frequencies || []).map((f) => ({
      khz: f.khz, mode: f.mode || 'usb', active: !!f.active, note: f._note || ''
    })),
    fields: SCHEMA.map((f) => ({
      key: f.key, group: f.group, label: f.label, type: f.type,
      min: f.min, max: f.max, values: f.values,
      maxLength: f.maxLength, pattern: f.pattern,
      help: f.help || null, measured: f.measured || null,
      value: getPath(cfg, f.key)
    })),
    appliesOnRestart: true
  };
}

/**
 * Apply a patch. Returns {ok, errors, changed}.
 * Nothing is written unless EVERY field validates -- a half-applied settings
 * change is harder to reason about than a rejected one.
 */
function apply(file, body, backupDir) {
  const cfg = readConfig(file);
  const changed = [];

  const { ok, errors, clean } = validate(body.settings || {});
  if (!ok) return { ok: false, errors };

  if (body.frequencies) {
    const fv = validateFrequencies(body.frequencies, cfg.frequencies || []);
    if (!fv.ok) return { ok: false, errors: { frequencies: fv.error } };
  }

  for (const [k, v] of Object.entries(clean)) {
    const before = getPath(cfg, k);
    if (before !== v) { setPath(cfg, k, v); changed.push(k + ': ' + before + ' -> ' + v); }
  }

  if (body.frequencies) {
    for (const f of body.frequencies) {
      const target = cfg.frequencies.find((x) => x.khz === f.khz);
      if (target && target.active !== f.active) {
        target.active = f.active;
        changed.push(f.khz + 'kHz: ' + (f.active ? 'ON' : 'off'));
      }
    }
  }

  if (changed.length) writeConfig(file, cfg, backupDir);
  return { ok: true, errors: {}, changed };
}

module.exports = {
  SCHEMA, validate, validateFrequencies, describe, apply,
  readConfig, writeConfig, getPath, setPath, AGC_DECAY_MS_MIN
};
