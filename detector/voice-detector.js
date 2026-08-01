'use strict';
//
// voice-detector.js -- decides when an HFGCS channel is carrying voice.
//
// Two-stage, as the measurements demand:
//
//   stage 1  flatness gate      rejects carriers and birdies outright
//                               (birdie 0.071 vs speech 0.368)
//   stage 2  modulation test    0.2-3 Hz envelope fraction against BOTH an
//                               absolute floor and a rolling per-channel floor
//
// The rolling floor exists because absolute thresholds do not survive contact
// with HF. A quiet European midday and a thundery Gulf Coast evening produce
// different baselines on the same frequency, and a fixed number is either deaf
// on one or screaming on the other. The floor is fed ONLY by non-triggered
// hops -- otherwise a five-minute EAM raises the very baseline it must exceed.
//
// THRESHOLD HONESTY
// -----------------
// modFractionAbsMin and modFractionRatioOverFloor are PROVISIONAL. The
// reference recording that produced every other constant here contains zero
// empty channel, so it constrains the positive class only and cannot set a
// false-positive rate. These two numbers are placeholders until Phase 1
// supplies an hour of real quiet channel. Nothing in this file should be read
// as a claim about false positives.

const { EventEmitter } = require('events');
const { FeatureExtractor } = require('./features');

const DEFAULT_CFG = {
  sampleRate: 12000,
  hop: 256,

  flatnessRejectBelow: 0.15,

  // VOICING GATE -- the feature that actually separates on real HF.
  //
  // Measured across 69 confirmed not-voice captures: median 0.00%, p95 0.22%,
  // max 10.4%. Against 3 confirmed voice captures: 3.1%, 35.6%, 38.3%.
  // Real static has no periodic voicing at all; speech does, even when weak.
  //
  // The modulation test below is retained but is known NOT to discriminate:
  // measured static reaches 0.703 against a real EAM's 0.712. It was fitted
  // against synthetic white noise, which has none of the fading, atmospheric
  // bursts or AGC pumping that generate 0.2-3 Hz envelope modulation on a real
  // receiver. Voicing is doing the work now.
  harmVoicedThreshold: 0.40,     // a hop counts as voiced above this
  minVoicedFraction: 0.03,       // 3% of the rolling window must be voiced

  modFractionAbsMin: 0.30,          // PROVISIONAL
  modFractionRatioOverFloor: 3.0,   // PROVISIONAL
  floorPercentile: 20,
  floorWindowMinutes: 30,
  floorMinSamples: 200,

  confirmSeconds: 0.5,
  hangoverSeconds: 3.0,
  minEventSeconds: 4.0,
  maxEventSeconds: 600
};

class VoiceDetector extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = Object.assign({}, DEFAULT_CFG, cfg || {});
    const c = this.cfg;

    // Object.assign copies undefined values, so passing a key this config
    // does not define would CLOBBER the FeatureExtractor default with
    // undefined rather than fall back to it. Only forward what is set.
    const feCfg = {};
    for (const k of ['sampleRate', 'hop', 'fftSize', 'voiceBandHz',
                     'envFftSize', 'modBandHz']) {
      if (c[k] !== undefined) feCfg[k] = c[k];
    }
    this.fe = new FeatureExtractor(feCfg);

    this.hopRate = c.sampleRate / c.hop;
    this.confirmHops = Math.max(1, Math.round(c.confirmSeconds * this.hopRate));
    this.hangoverHops = Math.max(1, Math.round(c.hangoverSeconds * this.hopRate));

    const floorLen = Math.max(
      c.floorMinSamples,
      Math.round(c.floorWindowMinutes * 60 * this.hopRate));
    this.floorBuf = new Float64Array(floorLen);
    this.floorFill = 0;
    this.floorPos = 0;
    this.floorValue = 0;
    this._floorScratch = new Float64Array(floorLen);
    this._floorDirty = true;

    // Rolling voicing history, same span as the envelope window (~5.5 s).
    // A whole-file average would miss a short transmission inside a long
    // capture -- km3t's speech was two seconds of seventeen.
    this.harmHist = new Uint8Array(this.fe.cfg.envFftSize);
    this.harmPos = 0;
    this.harmFill = 0;
    this.harmVoiced = 0;
    this.voicedFraction = 0;

    this.absPos = 0;          // absolute sample index of the NEXT sample
    this.state = 'idle';
    this.candidateHops = 0;
    this.quietHops = 0;

    this.event = null;
    this.stats = { triggers: 0, kept: 0, discarded: 0, hops: 0 };
  }

  get warm() { return this.fe.warm; }

  /**
   * @param {Int16Array} samples
   * @param {number} [absStart] absolute index of samples[0]; defaults to
   *        continuing from the last call.
   */
  process(samples, absStart) {
    if (typeof absStart === 'number') this.absPos = absStart;
    const c = this.cfg;

    this.fe.process(samples, (f) => {
      this.stats.hops++;
      // Absolute index of the LAST sample folded into this hop's window.
      const hopEndAbs = this.absPos + Math.min(samples.length, c.hop);
      this._onHop(f, hopEndAbs);
    });

    this.absPos += samples.length;
  }

  _onHop(f, hopEndAbs) {
    const c = this.cfg;

    // Voicing history is maintained from the first hop, warm or not -- it does
    // not depend on the envelope buffer being full.
    const isVoiced = f.harmonicity >= c.harmVoicedThreshold ? 1 : 0;
    if (this.harmFill === this.harmHist.length) {
      this.harmVoiced -= this.harmHist[this.harmPos];
    } else {
      this.harmFill++;
    }
    this.harmHist[this.harmPos] = isVoiced;
    this.harmVoiced += isVoiced;
    this.harmPos = (this.harmPos + 1) % this.harmHist.length;
    this.voicedFraction = this.harmFill ? this.harmVoiced / this.harmFill : 0;

    if (!f.warm) return;   // envelope history not yet meaningful

    const carrierLike = f.flatness < c.flatnessRejectBelow;
    const threshold = Math.max(
      c.modFractionAbsMin,
      this.floorValue * c.modFractionRatioOverFloor);
    // Both must hold: spectrally plausible AND actually voiced. The voicing
    // requirement is what removes the ~93% false-positive rate.
    const voiced = this.voicedFraction >= c.minVoicedFraction;
    const voiceLike = !carrierLike && f.modFraction >= threshold && voiced;

    if (!voiceLike && this.state === 'idle') this._pushFloor(f.modFraction);

    if (this.state === 'idle') {
      if (voiceLike) {
        this.candidateHops++;
        if (this.candidateHops === 1) this._candidateStartAbs = hopEndAbs;
        if (this.candidateHops >= this.confirmHops) {
          this.state = 'active';
          this.quietHops = 0;
          this.stats.triggers++;
          this.event = {
            startAbs: this._candidateStartAbs,
            peakModFraction: f.modFraction,
            sumModFraction: f.modFraction,
            hops: 1,
            floorAtTrigger: this.floorValue,
            thresholdAtTrigger: threshold
          };
          this.emit('trigger', {
            startAbs: this.event.startAbs,
            modFraction: f.modFraction,
            flatness: f.flatness,
            floor: this.floorValue,
            threshold
          });
        }
      } else {
        this.candidateHops = 0;
      }
      return;
    }

    // active
    const ev = this.event;
    ev.hops++;
    ev.sumModFraction += f.modFraction;
    if (f.modFraction > ev.peakModFraction) ev.peakModFraction = f.modFraction;

    if (voiceLike) {
      this.quietHops = 0;
    } else {
      this.quietHops++;
    }

    const durationSec = (hopEndAbs - ev.startAbs) / c.sampleRate;

    if (this.quietHops >= this.hangoverHops) {
      // Trim the hangover itself off the tail; it is silence by definition.
      const endAbs = hopEndAbs - Math.round(c.hangoverSeconds * c.sampleRate);
      this._close(Math.max(ev.startAbs, endAbs), 'hangover');
    } else if (durationSec >= c.maxEventSeconds) {
      this._close(hopEndAbs, 'max_length');
    }
  }

  _close(endAbs, reason) {
    const c = this.cfg;
    const ev = this.event;
    const durationSec = (endAbs - ev.startAbs) / c.sampleRate;
    const kept = durationSec >= c.minEventSeconds;

    if (kept) this.stats.kept++; else this.stats.discarded++;

    this.state = 'idle';
    this.candidateHops = 0;
    this.quietHops = 0;
    this.event = null;

    this.emit('release', {
      startAbs: ev.startAbs,
      endAbs,
      durationSec,
      kept,
      reason,
      peakModFraction: ev.peakModFraction,
      meanModFraction: ev.sumModFraction / Math.max(1, ev.hops),
      floorAtTrigger: ev.floorAtTrigger,
      thresholdAtTrigger: ev.thresholdAtTrigger
    });

    // max_length closes and immediately re-arms: a long EAM should become
    // consecutive segments, not one truncated clip followed by deafness.
    if (reason === 'max_length') {
      this.state = 'active';
      this.stats.triggers++;
      this.event = {
        startAbs: endAbs,
        peakModFraction: 0,
        sumModFraction: 0,
        hops: 0,
        floorAtTrigger: this.floorValue,
        thresholdAtTrigger: 0
      };
      this.emit('trigger', {
        startAbs: endAbs, modFraction: 0, flatness: 0,
        floor: this.floorValue, threshold: 0, continuation: true
      });
    }
  }

  _pushFloor(v) {
    this.floorBuf[this.floorPos] = v;
    this.floorPos = (this.floorPos + 1) % this.floorBuf.length;
    if (this.floorFill < this.floorBuf.length) this.floorFill++;
    this._floorDirty = true;

    // Recomputing a percentile every hop is wasteful and the floor moves
    // slowly; once a second is ample.
    if (this.stats.hops % Math.round(this.hopRate) === 0) this._recomputeFloor();
  }

  _recomputeFloor() {
    if (!this._floorDirty) return;
    const n = this.floorFill;
    if (n < this.cfg.floorMinSamples) { this.floorValue = 0; return; }

    const s = this._floorScratch.subarray(0, n);
    s.set(this.floorBuf.subarray(0, n));
    Array.prototype.sort.call(s, (a, b) => a - b);

    const idx = Math.min(n - 1, Math.max(0,
      Math.floor((this.cfg.floorPercentile / 100) * n)));
    this.floorValue = s[idx];
    this._floorDirty = false;
  }

  metrics() {
    return {
      state: this.state,
      warm: this.fe.warm,
      flatness: this.fe.lastFlatness,
      harmonicity: this.fe.lastHarmonicity,
      voicedFraction: this.voicedFraction,
      modFraction: this.fe.lastModFraction,
      floor: this.floorValue,
      threshold: Math.max(
        this.cfg.modFractionAbsMin,
        this.floorValue * this.cfg.modFractionRatioOverFloor),
      floorSamples: this.floorFill,
      stats: Object.assign({}, this.stats)
    };
  }

  /** Force-close an open event, e.g. when a session is rotating away. */
  flush(reason) {
    if (this.state === 'active' && this.event) {
      this._close(this.absPos, reason || 'flush');
    }
  }

  reset() {
    this.fe.reset();
    this.state = 'idle';
    this.candidateHops = 0;
    this.quietHops = 0;
    this.event = null;
    this.floorFill = 0; this.floorPos = 0; this.floorValue = 0;
    this._floorDirty = true;
    this.harmHist.fill(0); this.harmPos = 0; this.harmFill = 0;
    this.harmVoiced = 0; this.voicedFraction = 0;
  }
}

module.exports = { VoiceDetector, DEFAULT_CFG };
