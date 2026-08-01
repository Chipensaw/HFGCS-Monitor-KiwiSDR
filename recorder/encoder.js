'use strict';
//
// encoder.js -- turns a captured Int16 segment into a file on disk.
//
// WHY WAV IS THE DEFAULT
// ---------------------
// The AWS box has no ffmpeg, no opusenc, no sox. Installing ffmpeg from
// Debian pulls pocketsphinx and video drivers onto a headless relay, which is
// not a trade worth making for a codec.
//
// More importantly, Phase 1 exists to collect the empty-channel audio that
// calibrates the detector's two provisional thresholds. Calibration wants
// LOSSLESS input. Compressing the very recordings we intend to measure would
// be self-defeating.
//
// 12 kHz 16-bit mono is 24 kB/s -- 86 MB per hour of captured audio. For a
// supervised Phase 1 that is nothing, and browsers play WAV natively.
//
// The Opus backend is real but only engages if ffmpeg appears on PATH. It is
// the right choice once retention spans months rather than days; at 24 kbps
// the same hour is 10.8 MB.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WAV_HEADER_BYTES = 44;

/** Build a canonical 44-byte PCM WAV header. */
function wavHeader(sampleCount, sampleRate, channels) {
  channels = channels || 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const dataBytes = sampleCount * channels * 2;

  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);              // PCM fmt chunk size
  h.writeUInt16LE(1, 20);               // format = PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Write Int16 samples as a WAV file. Atomic: written to .tmp then renamed, so
 * a reader (or the monitor) never sees a half-written clip.
 */
function writeWav(filePath, samples, sampleRate) {
  const tmp = filePath + '.tmp';
  const header = wavHeader(samples.length, sampleRate, 1);
  const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  fs.writeFileSync(tmp, Buffer.concat([header, body]));
  fs.renameSync(tmp, filePath);
  return { path: filePath, bytes: header.length + body.length, codec: 'wav' };
}

let _ffmpegPath = undefined;   // undefined = not probed, null = absent

function findFfmpeg() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  _ffmpegPath = null;
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { fs.accessSync(p, fs.constants.X_OK); _ffmpegPath = p; break; } catch (_) { /* next */ }
  }
  return _ffmpegPath;
}

/** Transcode an existing WAV to Ogg/Opus. Resolves to null if ffmpeg absent. */
function toOpus(wavPath, opusPath, bitrateKbps) {
  return new Promise((resolve) => {
    const ff = findFfmpeg();
    if (!ff) return resolve(null);
    const tmp = opusPath + '.tmp';
    execFile(ff, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', wavPath,
      '-c:a', 'libopus', '-b:a', String(bitrateKbps || 24) + 'k',
      '-application', 'voip', '-ac', '1',
      tmp
    ], { timeout: 120000 }, (err) => {
      if (err) { try { fs.unlinkSync(tmp); } catch (_) {} return resolve(null); }
      try {
        fs.renameSync(tmp, opusPath);
        resolve({ path: opusPath, bytes: fs.statSync(opusPath).size, codec: 'opus' });
      } catch (_) { resolve(null); }
    });
  });
}

/**
 * Write a captured segment. Always produces WAV; additionally produces Opus
 * and drops the WAV when codec==='opus' AND ffmpeg exists.
 */
async function writeSegment(dir, basename, samples, sampleRate, opts) {
  opts = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  const wavPath = path.join(dir, basename + '.wav');
  const res = writeWav(wavPath, samples, sampleRate);

  if (opts.codec === 'opus') {
    const opus = await toOpus(wavPath, path.join(dir, basename + '.opus'), opts.bitrateKbps);
    if (opus) {
      if (!opts.keepWav) { try { fs.unlinkSync(wavPath); } catch (_) {} }
      return opus;
    }
    // ffmpeg missing or failed: the WAV already on disk is the deliverable.
    // Never lose a capture over a codec.
  }
  return res;
}

/**
 * Streaming WAV writer.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first implementation buffered a whole event in the ring and extracted it
 * on release. That silently bounded event length to the ring's capacity: with
 * a 60 s ring and maxEventSeconds=600, a long EAM lost its first 540 seconds
 * and nothing in the output said so.
 *
 * Streaming to disk from the moment of trigger removes the bound entirely.
 * The ring is now only responsible for pre-roll, which is what it was for.
 *
 * The header is written up-front with placeholder lengths and patched on
 * close, which avoids buffering or copying the payload.
 */
class WavStreamWriter {
  constructor(filePath, sampleRate) {
    this.path = filePath;
    this.tmp = filePath + '.tmp';
    this.sampleRate = sampleRate;
    this.samples = 0;
    this.fd = fs.openSync(this.tmp, 'w');
    fs.writeSync(this.fd, wavHeader(0, sampleRate, 1));
    this.closed = false;
  }

  write(int16) {
    if (this.closed || !int16 || int16.length === 0) return;
    fs.writeSync(this.fd, Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength));
    this.samples += int16.length;
  }

  /** @param {number} [limitSamples] truncate to this many samples */
  close(limitSamples) {
    if (this.closed) return { path: this.path, samples: this.samples };
    this.closed = true;

    if (Number.isFinite(limitSamples) && limitSamples >= 0 && limitSamples < this.samples) {
      fs.ftruncateSync(this.fd, WAV_HEADER_BYTES + limitSamples * 2);
      this.samples = limitSamples;
    }
    // Patch the two length fields now that the payload length is known.
    const h = wavHeader(this.samples, this.sampleRate, 1);
    fs.writeSync(this.fd, h, 0, WAV_HEADER_BYTES, 0);
    fs.closeSync(this.fd);
    fs.renameSync(this.tmp, this.path);
    return {
      path: this.path,
      samples: this.samples,
      bytes: WAV_HEADER_BYTES + this.samples * 2,
      codec: 'wav'
    };
  }

  abort() {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } catch (_) {}
    try { fs.unlinkSync(this.tmp); } catch (_) {}
  }
}

module.exports = {
  writeWav, wavHeader, writeSegment, toOpus, findFfmpeg,
  WavStreamWriter, WAV_HEADER_BYTES
};
