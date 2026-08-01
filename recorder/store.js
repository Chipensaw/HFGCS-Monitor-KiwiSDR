'use strict';
//
// store.js -- everything the recorder puts on disk.
//
// Layout mirrors the survey's discipline: the writer owns this tree, the
// monitor only ever reads it.
//
//   data/events/YYYY-MM-DD/<stamp>_<freq>_<site>.wav
//   data/events/YYYY-MM-DD/events.jsonl
//   data/index.json          rolling recent-events view for the web page
//   data/coverage.jsonl      per-frequency monitored minutes, appended hourly
//   data/status.json         live state for the monitor
//
// Day directories are the retention unit: retention.sh deletes whole days, so
// a clip and the JSONL line describing it always disappear together. Nothing
// here can produce an orphan.
//
// Every whole-file write is atomic (.tmp + rename). The monitor reads these
// files on a timer with no locking, so a torn read must be impossible rather
// than unlikely.

const fs = require('fs');
const path = require('path');
const { writeSegment } = require('./encoder');

function utcDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function stamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Make a site identifier safe as a filename component.
 *
 * Replacing separators alone is not enough: 'evil/../x' becomes 'evil_.._x',
 * which is harmless as a flat name but ugly and easy to misread in a log or a
 * URL. Runs of dots collapse too, so nothing that looks like traversal
 * survives into the output.
 */
function safeSite(site) {
  return String(site == null ? 'unknown' : site)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '') || 'unknown';
}

function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(root, opts) {
    this.root = root;
    this.eventsRoot = path.join(root, 'events');
    this.opts = Object.assign({ codec: 'wav', bitrateKbps: 24, indexLimit: 500 }, opts || {});
    fs.mkdirSync(this.eventsRoot, { recursive: true });
  }

  dayDir(when) {
    const d = path.join(this.eventsRoot, utcDay(when));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * Persist one detection.
   * @param {Int16Array} samples
   * @param {object} meta  {freqKHz, site, startedAt, durationSec, sampleRate, ...}
   */
  async writeEvent(samples, meta) {
    const when = meta.startedAt || Date.now();
    const dir = this.dayDir(when);
    const site = safeSite(meta.site);
    const base = stamp(when) + '_' + meta.freqKHz + '_' + site;

    const written = await writeSegment(dir, base, samples, meta.sampleRate, {
      codec: this.opts.codec,
      bitrateKbps: this.opts.bitrateKbps
    });

    const record = Object.assign({}, meta, {
      id: base,
      day: utcDay(when),
      file: path.basename(written.path),
      codec: written.codec,
      bytes: written.bytes,
      startedAt: new Date(when).toISOString(),
      samples: samples.length
    });

    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(record) + '\n');
    this.refreshIndex();
    return record;
  }

  /**
   * Append an already-written capture to the log. Used by the streaming
   * capture path, where the audio file exists before the record does.
   */
  appendRecord(record) {
    const dir = this.dayDir(record.startedAt || Date.now());
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(record) + '\n');
    this.refreshIndex();
    return record;
  }

  /** Read back the most recent N events across day directories. */
  recentEvents(limit) {
    limit = limit || this.opts.indexLimit;
    let days;
    try {
      days = fs.readdirSync(this.eventsRoot)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort().reverse();
    } catch (_) { return []; }

    const out = [];
    for (const day of days) {
      const f = path.join(this.eventsRoot, day, 'events.jsonl');
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { out.push(JSON.parse(lines[i])); } catch (_) { /* skip torn line */ }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  refreshIndex() {
    const events = this.recentEvents();
    atomicWriteJson(path.join(this.root, 'index.json'), {
      generatedAt: new Date().toISOString(),
      count: events.length,
      events
    });
  }

  writeStatus(status) {
    atomicWriteJson(path.join(this.root, 'status.json'),
      Object.assign({ updatedAt: new Date().toISOString() }, status));
  }

  /**
   * Append a coverage sample. Rotation and slot contention mean transmissions
   * WILL be missed; publishing the gaps is the difference between a sampling
   * recorder and one that quietly implies completeness.
   */
  appendCoverage(row) {
    fs.appendFileSync(path.join(this.root, 'coverage.jsonl'),
      JSON.stringify(Object.assign({ at: new Date().toISOString() }, row)) + '\n');
  }
}

module.exports = { Store, utcDay, stamp, safeSite, atomicWriteJson };
