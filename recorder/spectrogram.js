'use strict';
//
// spectrogram.js -- renders a capture to a small PNG thumbnail.
//
// WHY A HAND-ROLLED PNG ENCODER
// -----------------------------
// The box has no canvas, sharp or pngjs, 446 MB of RAM free, and is also
// running the production relay. Pulling in a native image library to draw a
// 240x64 greyscale image is not a trade worth making. PNG's baseline format is
// small enough to emit directly: a fixed header, a zlib-compressed pixel
// stream, and CRC32 over each chunk. zlib is built into Node.
//
// WHY THUMBNAILS AT ALL
// ---------------------
// Speech, data bursts and carriers look completely different in a spectrogram
// and nearly identical in a table of numbers. Several hours were lost this week
// to questions -- "is this voice or a data mode", "did the transmission really
// stop here" -- that one glance at a waterfall would have answered. The numbers
// are a summary; this is the evidence.
//
// Rendered once when the capture is written, then served as a static file.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { makeFFT, hannWindow } = require('../detector/features');

// ---- CRC32 (PNG chunk checksums) ------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode 8-bit RGB pixels as a PNG.
 * @param {Buffer} rgb  width*height*3 bytes
 */
function encodePng(rgb, width, height) {
  // PNG requires a filter byte at the start of every scanline. 0 = none;
  // the image is small and zlib handles the redundancy well enough.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * width * 3;
    const dst = y * (width * 3 + 1);
    raw[dst] = 0;
    rgb.copy(raw, dst + 1, src, src + width * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type 2 = truecolour RGB
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- colour map -----------------------------------------------------------
// The "jet" ramp a KiwiSDR waterfall uses: deep blue noise floor, through cyan
// and green, to yellow and red for the strongest signal. Chosen to match what
// an operator already reads fluently rather than to be pretty -- a familiar
// palette is worth more than an original one.
function colourise(v) {
  const x = Math.max(0, Math.min(1, v));
  let r, g, b;
  if (x < 0.125)      { r = 0;   g = 0;   b = 128 + 1016 * x; }
  else if (x < 0.375) { r = 0;   g = 1020 * (x - 0.125); b = 255; }
  else if (x < 0.625) { r = 1020 * (x - 0.375); g = 255; b = 255 - 1020 * (x - 0.375); }
  else if (x < 0.875) { r = 255; g = 255 - 1020 * (x - 0.625); b = 0; }
  else                { r = 255 - 1016 * (x - 0.875); g = 0; b = 0; }
  return [Math.min(255, r) | 0, Math.min(255, g) | 0, Math.min(255, b) | 0];
}

const DEFAULTS = {
  width: 360,
  // Taller = more time detail. At 96 rows a 100 s capture gave ~1 s per row,
  // which smeared the syllable structure into a wash. 144 shows half again as
  // much history for the same width.
  height: 144,
  fftSize: 1024,
  // FULL audio span, not just the passband.
  //
  // Cropping to 200-3000 Hz blew the SSB passband up to fill the whole frame,
  // which is why it read as "zoomed in" -- there was no noise floor around the
  // signal to give it scale. Showing 0 to Nyquist puts the 300-2700 Hz voice
  // channel in about 40% of the width with quiet either side, which is the
  // proportion a receiver's own waterfall shows.
  //
  // 6 kHz is the ceiling: we get DEMODULATED audio, not RF spectrum. A real
  // Kiwi waterfall spans tens of kHz, and reaching that needs the W/F socket,
  // which tears the session down at ~26 s (see kiwi-audio-client.js).
  bandHz: [0, 3400],
  // p55 puts the floor at the quiet region above the SSB filter skirt, so that
  // half of the image reads as deep blue noise and the voice channel climbs the
  // ramp. p20 left almost nothing blue and the whole frame read as signal.
  // p25 now the band is cropped to 0-3400. The floor percentile has to track
  // the band: with the full 6 kHz span more than half of every image was dead
  // stopband, so p55 landed on the noise floor. Cropping removed that dead
  // half, and p55 then landed INSIDE the signal and rendered the whole image
  // flat blue. p25 puts it back on the floor.
  //
  // Sensitive: p20 and p25 differ sharply because the floor sits on the cliff
  // between signal and stopband. If the band changes again, re-measure.
  floorPercentile: 25,
  // Real captures span far more than the clean reference recording does: with
  // 45 dB, 36% of a typical image sat pegged at the red end of the ramp and the
  // whole passband read as saturated crimson. Receiver AGC widens the range
  // rather than narrowing it. 75 dB leaves ~9% at the top, so peaks still show
  // red but the body of the signal spreads across the ramp.
  // Measured across five real captures:
  //    45 dB -> 36% red      whole passband crimson
  //    75 dB ->  7% red      still hot
  //   100 dB ->  1% red      57% blue, 28% cyan, peaks still visible
  // Measured across five real captures at the 0-3400 band:
  //   26% below 0.2 (blue floor), 31% 0.2-0.5, 42% 0.5-0.8 (the body),
  //   1% above 0.8 (peaks). Wider headroom flattened everything to blue.
  headroomDb: 30,
  // Frames averaged into each row. The first version took ONE fft per row and
  // skipped the audio between: a 103 s capture rendered 9.9% of its own samples
  // and a 300 s capture 3.4%. The result was harsh striping that looked like
  // signal structure and was pure aliasing.
  maxFramesPerColumn: 24,
  // Contrast curve. >1 darkens the low end. The jet ramp already separates
  // floor from signal, so 1.0 is honest.
  gamma: 1.0,
  // RF only: the narrowest dB range the colour ramp may be stretched over.
  // A signal-free band has just the receiver's own noise variation -- roughly
  // 10-15 dB -- and stretching THAT across the full ramp turns an empty
  // channel into full-frame speckle that reads as though something is there.
  // Real captures span 40+ dB floor-to-signal, so holding the scale open to
  // at least this much keeps a quiet band blue without moving a real signal.
  // Measured: quiet band 37% -> 62% deep blue; a band WITH a signal unchanged.
  minSpanDb: 45
};

/**
 * Render Int16 PCM to a PNG waterfall.
 *
 * Frequency across, time DOWNWARD -- the orientation a KiwiSDR shows and that
 * an operator reads without thinking. The first version had these swapped,
 * which made a familiar picture unfamiliar for no gain.
 */
function render(samples, sampleRate, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const N = o.fftSize;
  const fft = makeFFT(N);
  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  const binHz = sampleRate / N;
  const loBin = Math.max(1, Math.round(o.bandHz[0] / binHz));
  const hiBin = Math.min(N / 2 - 1, Math.round(o.bandHz[1] / binHz));
  const nBins = hiBin - loBin + 1;

  // One column per output pixel, so the whole capture fits regardless of
  // length. Every frame inside a column's time span is averaged in, so no
  // audio is skipped -- see maxFramesPerColumn.
  const usable = Math.max(N, samples.length - N);
  const step = usable / o.height;

  // Hop within a row. Capped so a long capture does not cost proportionally
  // more CPU; beyond the cap the frames are spread evenly across the span,
  // which still samples the whole row rather than only its first 85 ms.
  const frames = Math.max(1, Math.min(o.maxFramesPerColumn, Math.floor(step / (N / 2))));
  const inner = frames > 1 ? (step - N) / (frames - 1) : 0;

  const cells = new Float64Array(o.width * o.height);
  const acc = new Float64Array(N / 2);
  const all = [];

  for (let y = 0; y < o.height; y++) {
    acc.fill(0);
    const base = y * step;
    let used = 0;

    for (let f = 0; f < frames; f++) {
      const start = Math.min(samples.length - N, Math.max(0, Math.floor(base + f * inner)));
      if (start + N > samples.length) break;
      for (let i = 0; i < N; i++) {
        re[i] = (samples[start + i] / 32768) * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let b = loBin; b <= hiBin; b++) acc[b] += re[b] * re[b] + im[b] * im[b];
      used++;
    }
    if (!used) used = 1;

    for (let x = 0; x < o.width; x++) {
      // Left edge = lowest frequency.
      const b0 = loBin + Math.floor((x / o.width) * nBins);
      const b1 = Math.max(b0 + 1, loBin + Math.floor(((x + 1) / o.width) * nBins));
      let p = 0;
      for (let b = b0; b < b1 && b <= hiBin; b++) p += acc[b];
      const db = 10 * Math.log10(p / (Math.max(1, b1 - b0) * used) + 1e-14);
      cells[y * o.width + x] = db;
      all.push(db);
    }
  }

  // Scale per image rather than absolutely: receivers differ by tens of dB in
  // gain, and an absolute scale would render half of them as flat black.
  all.sort((a, b) => a - b);
  const floor = all[Math.floor((o.floorPercentile / 100) * all.length)];
  const span = o.headroomDb;

  // PNG rows run top-down, and so does time here: oldest audio at the top,
  // newest at the bottom, exactly as a live waterfall scrolls.
  const rgb = Buffer.alloc(o.width * o.height * 3);
  for (let y = 0; y < o.height; y++) {
    for (let x = 0; x < o.width; x++) {
      const db = cells[y * o.width + x];
      const norm = Math.max(0, Math.min(1, (db - floor) / span));
      const [r, g, b] = colourise(Math.pow(norm, o.gamma));
      const px = (y * o.width + x) * 3;
      rgb[px] = r; rgb[px + 1] = g; rgb[px + 2] = b;
    }
  }

  return encodePng(rgb, o.width, o.height);
}

/**
 * Render RF waterfall rows straight from the receiver.
 *
 * The audio path FFTs demodulated audio and can never show more than 6 kHz.
 * These rows are actual radio spectrum -- typically 29 kHz across -- so a 3 kHz
 * SSB signal appears as a narrow band in context, which is the whole point.
 */
function renderWaterfall(wf, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const src = wf && wf.rows;
  if (!src || src.length < 2) return null;

  // Render at the height the DATA supports, never taller. Stretching 20 rows
  // over 144 pixels repeats each one seven times and produces a blocky ladder
  // that looks like signal structure and is pure upsampling. A short capture
  // gets a short thumbnail; that is honest.
  const height = Math.max(8, Math.min(o.height, src.length));

  const nBins = src[0].length;
  const cells = new Float64Array(o.width * height);
  const all = [];

  for (let y = 0; y < height; y++) {
    const r0 = Math.floor((y / height) * src.length);
    const r1 = Math.max(r0 + 1, Math.floor(((y + 1) / height) * src.length));
    for (let x = 0; x < o.width; x++) {
      const b0 = Math.floor((x / o.width) * nBins);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / o.width) * nBins));
      let sum = 0, n = 0;
      for (let r = r0; r < r1 && r < src.length; r++) {
        const bins = src[r];
        for (let b = b0; b < b1 && b < nBins; b++) {
          // dBm = byte - 255 (send_dB=1). Already logarithmic, so average in dB
          // rather than converting to power and back: these are display values.
          sum += bins[b] - 255;
          n++;
        }
      }
      const db = n ? sum / n : -255;
      cells[y * o.width + x] = db;
      all.push(db);
    }
  }

  all.sort((a, b) => a - b);
  const floor = all[Math.floor((o.floorPercentile / 100) * all.length)];
  // RF rows have a much wider spread than audio: a quiet band sits near the
  // receiver noise floor while a strong signal is 40+ dB above it. The audio
  // headroom is far too narrow, so scale to the data actually present.
  const top = all[Math.floor(0.995 * all.length)];
  const span = Math.max(o.minSpanDb, top - floor);

  const rgb = Buffer.alloc(o.width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < o.width; x++) {
      const norm = Math.max(0, Math.min(1, (cells[y * o.width + x] - floor) / span));
      const [r, g, b] = colourise(Math.pow(norm, o.gamma));
      const px = (y * o.width + x) * 3;
      rgb[px] = r; rgb[px + 1] = g; rgb[px + 2] = b;
    }
  }
  return encodePng(rgb, o.width, height);
}

/** Read a 16-bit PCM WAV. Returns null rather than throwing on a bad file. */
function readWav(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.toString('latin1', 0, 4) !== 'RIFF') return null;
    let pos = 12, fmt = null, data = null;
    while (pos + 8 <= b.length) {
      const id = b.toString('latin1', pos, pos + 4);
      const size = b.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === 'fmt ') fmt = { channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4) };
      else if (id === 'data') data = b.subarray(body, body + size);
      pos = body + size + (size % 2);
    }
    if (!fmt || !data) return null;
    const n = Math.floor(data.length / 2 / fmt.channels);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * fmt.channels);
    return { samples: out, rate: fmt.rate };
  } catch (e) {
    return null;
  }
}

/**
 * Render a capture to <name>.png beside it. Written atomically so the monitor
 * never serves a half-written image.
 *
 * Returns the filename, or null on any failure -- a missing thumbnail must
 * never cost us a capture.
 */
function renderFile(wavPath, opts) {
  const w = readWav(wavPath);
  if (!w || w.samples.length < DEFAULTS.fftSize * 2) return null;
  try {
    const png = render(w.samples, w.rate, opts);
    const out = wavPath.replace(/\.wav$/, '.png');
    const tmp = out + '.tmp';
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, out);
    return path.basename(out);
  } catch (e) {
    return null;
  }
}

/**
 * Prefer the RF waterfall; fall back to the audio spectrogram.
 * A thumbnail must never cost a capture, so any failure degrades quietly.
 */
function renderFileWith(wavPath, wf, opts) {
  const out = wavPath.replace(/\.wav$/, '.png');
  const tmp = out + '.tmp';
  if (wf && wf.rows && wf.rows.length >= 2) {
    try {
      const png = renderWaterfall(wf, opts);
      if (png) {
        fs.writeFileSync(tmp, png);
        fs.renameSync(tmp, out);
        return { file: path.basename(out), source: 'rf' };
      }
    } catch (e) { /* fall through to audio */ }
  }
  const name = renderFile(wavPath, opts);
  return name ? { file: name, source: 'audio' } : null;
}

module.exports = {
  render, renderWaterfall, renderFile, renderFileWith,
  readWav, encodePng, DEFAULTS
};
