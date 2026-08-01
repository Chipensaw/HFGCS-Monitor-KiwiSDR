'use strict';
//
// labels.js -- listener labels and capture deletion.
//
// WHY LABELS EXIST
// ----------------
// The detector's thresholds were fitted against synthetic noise and did not
// survive contact with real HF: measured static reached 0.703 on the modulation
// feature against a real EAM's 0.712. The only way to set them honestly is to
// fit against captures a human has actually listened to. This is that record.
//
// Labels live in their own append-only file, NOT in events.jsonl. The recorder
// owns events.jsonl and the monitor must never write to it -- one writer per
// file is the rule that keeps the survey's data trustworthy and it applies
// here too.
//
// DELETION IS SOFT, ON PURPOSE
// ----------------------------
// Captures move to data/trash/<day>/ rather than being unlinked. These files
// are currently the only labelled data this project has, and a mis-click on
// "select all" would be unrecoverable. The retention sweep already prunes by
// age, so trash cleans itself up without anyone having to remember.

const fs = require('fs');
const path = require('path');

const VALID_LABELS = ['voice', 'static', 'data', 'unsure'];
const ID_RE = /^[A-Za-z0-9._-]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function labelsFile(dataRoot) {
  return path.join(dataRoot, 'labels.jsonl');
}

/**
 * Read all labels, last write wins per id.
 * Append-only on disk so the history survives; collapsed on read so the UI
 * sees one current answer.
 */
function readLabels(dataRoot) {
  const out = {};
  let text;
  try { text = fs.readFileSync(labelsFile(dataRoot), 'utf8'); } catch (_) { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.id) out[r.id] = r;
    } catch (_) { /* skip torn line */ }
  }
  return out;
}

function putLabel(dataRoot, id, label, who) {
  if (!ID_RE.test(String(id))) return { ok: false, error: 'bad id' };
  if (VALID_LABELS.indexOf(label) === -1) {
    return { ok: false, error: 'label must be one of ' + VALID_LABELS.join(', ') };
  }
  const rec = { id, label, at: new Date().toISOString(), by: who || 'unknown' };
  fs.appendFileSync(labelsFile(dataRoot), JSON.stringify(rec) + '\n');
  return { ok: true, record: rec };
}

/**
 * Move captures to trash. Returns per-id outcome rather than failing the whole
 * batch on one bad entry -- a select-all delete should not be defeated by a
 * single already-removed file.
 */
function trashCaptures(dataRoot, items, who) {
  const results = [];
  for (const it of items || []) {
    const day = it && it.day;
    const file = it && it.file;
    if (!DAY_RE.test(String(day)) || !ID_RE.test(String(file))) {
      results.push({ day, file, ok: false, error: 'bad path' });
      continue;
    }
    const src = path.resolve(dataRoot, 'events', day, file);
    const eventsRoot = path.resolve(dataRoot, 'events');
    if (!src.startsWith(eventsRoot + path.sep)) {
      results.push({ day, file, ok: false, error: 'outside events tree' });
      continue;
    }
    const dstDir = path.join(dataRoot, 'trash', day);
    try {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.renameSync(src, path.join(dstDir, file));
      results.push({ day, file, ok: true });
    } catch (e) {
      results.push({ day, file, ok: false, error: e.code || e.message });
    }
  }
  const moved = results.filter((r) => r.ok).length;
  if (moved) {
    fs.appendFileSync(path.join(dataRoot, 'trash-log.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), by: who || 'unknown',
                       moved, items: results.filter((r) => r.ok).map((r) => r.day + '/' + r.file) }) + '\n');
  }
  return { moved, results };
}

/** Counts by label, for showing progress while listening through a night. */
function labelStats(dataRoot) {
  const labels = readLabels(dataRoot);
  const counts = { voice: 0, static: 0, data: 0, unsure: 0 };
  for (const k in labels) {
    const l = labels[k].label;
    if (counts[l] !== undefined) counts[l]++;
  }
  return { total: Object.keys(labels).length, counts };
}

module.exports = { readLabels, putLabel, trashCaptures, labelStats, VALID_LABELS };
