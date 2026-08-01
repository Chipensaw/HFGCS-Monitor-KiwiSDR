'use strict';
//
// ring-buffer.js -- fixed-capacity Int16 PCM ring with absolute addressing.
//
// The recorder needs pre-roll: when the detector latches, the syllable that
// triggered it is already several hundred milliseconds in the past, and the
// carrier before it is what makes a clip listenable. Trigger-on-detect loses
// the first word of every transmission.
//
// Addressing is by ABSOLUTE sample index (total samples ever written), not by
// ring offset. The detector reports "voice started at sample 41,203,776" and
// the recorder asks for that range without either side reasoning about wrap.
//
// The important design choice here is that a range which has already been
// overwritten is an ERROR, not a shrug. If the encoder falls behind and the
// ring laps the requested pre-roll, silently returning whatever is resident
// would splice unrelated audio into the middle of a clip and nothing
// downstream could tell. Callers use available() to negotiate, or catch.
//
// Memory: 60 s at 12 kHz Int16 = 1.44 MB per channel; 8.6 MB across six.
// Allocated once at construction and never grown.

class RingBuffer {
  /** @param {number} capacitySamples */
  constructor(capacitySamples) {
    if (!Number.isInteger(capacitySamples) || capacitySamples <= 0) {
      throw new Error('capacitySamples must be a positive integer');
    }
    this.capacity = capacitySamples;
    this.buf = new Int16Array(capacitySamples);
    this.written = 0;          // absolute count of samples ever written
  }

  static forSeconds(seconds, sampleRate) {
    return new RingBuffer(Math.ceil(seconds * sampleRate));
  }

  /** Absolute range currently resident: [from, to). Empty when from === to. */
  available() {
    const to = this.written;
    const from = Math.max(0, to - this.capacity);
    return { from, to };
  }

  /**
   * Append samples. Chunks longer than capacity keep only the tail, which is
   * the only sane interpretation and beats throwing on a burst.
   */
  write(samples) {
    if (!samples || samples.length === 0) return this.written;
    let src = samples;
    let n = src.length;

    if (n >= this.capacity) {
      src = src.subarray(n - this.capacity);
      n = this.capacity;
      // Everything previously resident is gone; account for the skipped part.
      this.written += samples.length - n;
    }

    const head = this.written % this.capacity;
    const firstRun = Math.min(n, this.capacity - head);

    this.buf.set(src.subarray(0, firstRun), head);
    if (firstRun < n) this.buf.set(src.subarray(firstRun), 0);

    this.written += n;
    return this.written;
  }

  /**
   * Copy out an absolute range [fromAbs, toAbs).
   * @throws if the range is not fully resident.
   */
  read(fromAbs, toAbs) {
    if (!Number.isFinite(fromAbs) || !Number.isFinite(toAbs)) {
      throw new Error('read() bounds must be finite');
    }
    if (toAbs < fromAbs) throw new Error('read() toAbs < fromAbs');

    const av = this.available();
    if (fromAbs < av.from) {
      throw new Error(
        'requested sample ' + fromAbs + ' has been overwritten (oldest resident is ' +
        av.from + '); ring lapped by ' + (av.from - fromAbs) + ' samples');
    }
    if (toAbs > av.to) {
      throw new Error(
        'requested sample ' + toAbs + ' not yet written (newest is ' + av.to + ')');
    }

    const n = toAbs - fromAbs;
    const out = new Int16Array(n);
    if (n === 0) return out;

    const start = fromAbs % this.capacity;
    const firstRun = Math.min(n, this.capacity - start);
    out.set(this.buf.subarray(start, start + firstRun), 0);
    if (firstRun < n) out.set(this.buf.subarray(0, n - firstRun), firstRun);
    return out;
  }

  /** Most recent n samples. Clamped to what is resident. */
  readLast(n) {
    const av = this.available();
    const from = Math.max(av.from, av.to - n);
    return this.read(from, av.to);
  }

  /** True when [fromAbs, toAbs) can still be read. */
  hasRange(fromAbs, toAbs) {
    const av = this.available();
    return fromAbs >= av.from && toAbs <= av.to && toAbs >= fromAbs;
  }

  reset() {
    this.written = 0;
    this.buf.fill(0);
  }
}

module.exports = { RingBuffer };
