'use strict';
//
// features.js -- the DSP the HFGCS detector rests on.
//
// EVERY CONSTANT BELOW CAME FROM MEASUREMENT, NOT FROM LITERATURE
// ---------------------------------------------------------------
// Measured against a real 146 s USAF EAM capture (8992 kHz, 27 Jun 2016)
// resampled to 12 kHz, plus synthetic negatives:
//
//                        flatness   mod 0.2-3Hz   mod 3-8Hz   harmonicity
//   EAM (real)             0.368       73.7%        21.7%        0.275
//   band-limited noise     0.562       20.4%        35.6%        0.191
//   AGC'd empty channel    0.562        2.5%        16.5%        0.191
//   noise + static         0.552       23.9%        39.3%        0.196
//   noise + carrier        0.071       21.0%        34.1%        0.840
//
// Three conclusions, all of which contradict the obvious design:
//
//  1. The discriminating band is 0.2-3 Hz, NOT the 3-8 Hz syllable rate from
//     conversational-speech literature. An EAM is a slow, evenly paced
//     phonetic readout -- envelope peak measured at 0.73 Hz. In the 3-8 Hz
//     band the NOISE classes score HIGHER than the transmission, so a 3-8 Hz
//     detector ranks lightning crashes above the signal.
//
//  2. Harmonicity is a trap. A steady carrier scores 0.840 against speech at
//     0.275 -- it fires hardest on exactly what we want to reject. Spectral
//     flatness is the carrier rejector instead (0.071 vs 0.368), used as a
//     LOW-side gate only: noise sits above speech at 0.562 and is handled by
//     the modulation test.
//
//  3. Frame energy is useless. Level arrives flat through receiver AGC; it
//     carried no information across the entire reference recording.
//
// The receiver-side AGC constraint (decay >= 1000 ms) is enforced in
// kiwi-audio-client.js. A 100 ms AGC is a ~1.6 Hz corner on the envelope and
// notches this feature band, costing 75% of the discriminator.

const DEFAULT_CFG = {
  sampleRate: 12000,
  fftSize: 512,          // 23.44 Hz/bin
  hop: 256,              // 46.875 hops/s
  voiceBandHz: [300, 2700],
  envFftSize: 256,       // 5.46 s of envelope, 0.183 Hz/bin
  modBandHz: [0.2, 3.0],
  // Autocorrelation pitch search. Voiced speech is periodic in 70-300 Hz;
  // static is not. Measured on real captures this is the ONLY feature that
  // separates true voice (0.81, 0.84) from spectrally-structured non-voice
  // like a data burst (0.435) and plain static (0.26).
  harmFrameSec: 0.032,
  pitchHz: [70, 300],
  // MAINS HUM REJECTION.
  //
  // Powerline noise is periodic, and its harmonics (100/120, 150/180,
  // 200/240 Hz) fall inside the voice pitch range. The autocorrelation test
  // cannot tell that apart from a voice by strength alone -- measured on a
  // known-buzzing receiver, 100% of "voiced" hops sat at 120.0 Hz and it
  // produced 11 false captures in one night.
  //
  // The discriminator is STABILITY, not frequency. Human pitch wanders:
  // measured across a real EAM, relative spread (p90-p10)/p50 was 0.842.
  // Mains hum is locked to the grid: 0.020, a 40x difference. So a hop is
  // rejected only if its pitch is BOTH on a mains harmonic AND unnaturally
  // steady -- a voice that happens to pass through 120 Hz still counts.
  mainsHz: [50, 60],
  mainsTolHz: 3.0,
  mainsStabilityWindow: 12,      // hops of pitch history to judge steadiness
  pitchTrackMinCorr: 0.40,       // only track pitch from hops that looked voiced
  mainsMaxSpread: 0.08           // relative spread below this = machine, not voice
};

// -- FFT: iterative radix-2, precomputed tables, no allocation per call -----
function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  if (2 ** levels !== n) throw new Error('FFT size must be a power of 2, got ' + n);

  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / n);
    sin[i] = Math.sin(2 * Math.PI * i / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }

  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre =  re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre;        im[j] += tim;
        }
      }
    }
  };
}

function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

/**
 * Streaming feature extractor. Feed arbitrary-length Int16 chunks; it emits
 * one feature set per hop via the callback given to process().
 *
 * Nothing is allocated in the steady-state path.
 */
class FeatureExtractor {
  constructor(cfg) {
    this.cfg = Object.assign({}, DEFAULT_CFG, cfg || {});
    const c = this.cfg;

    this.fft = makeFFT(c.fftSize);
    this.envFft = makeFFT(c.envFftSize);
    this.win = hannWindow(c.fftSize);
    this.envWin = hannWindow(c.envFftSize);

    this.binHz = c.sampleRate / c.fftSize;
    this.vLo = Math.max(1, Math.round(c.voiceBandHz[0] / this.binHz));
    this.vHi = Math.min(c.fftSize / 2 - 1, Math.round(c.voiceBandHz[1] / this.binHz));
    if (this.vHi <= this.vLo) throw new Error('voice band collapses at this fftSize');

    // Sample-domain sliding window
    this.hist = new Int16Array(c.fftSize);
    this.histFill = 0;
    this.histPos = 0;
    this.sinceHop = 0;

    this.re = new Float64Array(c.fftSize);
    this.im = new Float64Array(c.fftSize);

    // Envelope domain
    this.envRate = c.sampleRate / c.hop;
    this.envBinHz = this.envRate / c.envFftSize;
    this.env = new Float64Array(c.envFftSize);
    this.envPos = 0;
    this.envFill = 0;
    this.eRe = new Float64Array(c.envFftSize);
    this.eIm = new Float64Array(c.envFftSize);

    this.mLo = Math.max(1, Math.round(c.modBandHz[0] / this.envBinHz));
    this.mHi = Math.min(c.envFftSize / 2 - 1, Math.round(c.modBandHz[1] / this.envBinHz));
    if (this.mHi <= this.mLo) throw new Error('modulation band collapses at this envFftSize');

    // Harmonicity works on a 32 ms frame taken from the tail of the same
    // sample history the FFT uses, so it needs no extra buffer.
    this.harmLen = Math.min(c.fftSize, Math.round(c.harmFrameSec * c.sampleRate));
    this.harmWin = hannWindow(this.harmLen);
    this.harmBuf = new Float64Array(this.harmLen);
    this.lagLo = Math.floor(c.sampleRate / c.pitchHz[1]);
    this.lagHi = Math.min(this.harmLen - 1, Math.floor(c.sampleRate / c.pitchHz[0]));

    // Rolling pitch history, for the mains-stability test.
    this.pitchHist = new Float64Array(c.mainsStabilityWindow);
    this.pitchPos = 0;
    this.pitchFill = 0;

    this.hops = 0;
    this.lastFlatness = 0;
    this.lastVoicePower = 0;
    this.lastModFraction = 0;
    this.lastHarmonicity = 0;
    this.lastPitchHz = 0;
    this.lastMainsLocked = false;
  }

  /** True once the envelope history is full enough for a valid modFraction. */
  get warm() { return this.envFill >= this.cfg.envFftSize; }

  /** Seconds of audio needed before modFraction means anything. */
  get warmupSeconds() { return this.cfg.envFftSize * this.cfg.hop / this.cfg.sampleRate; }

  /**
   * @param {Int16Array} samples
   * @param {(f:{hopIndex:number,flatness:number,voicePower:number,modFraction:number,warm:boolean})=>void} onHop
   */
  process(samples, onHop) {
    const c = this.cfg;
    for (let i = 0; i < samples.length; i++) {
      this.hist[this.histPos] = samples[i];
      this.histPos = (this.histPos + 1) % c.fftSize;
      if (this.histFill < c.fftSize) this.histFill++;
      this.sinceHop++;

      if (this.sinceHop >= c.hop && this.histFill >= c.fftSize) {
        this.sinceHop = 0;
        this._hop();
        if (onHop) {
          onHop({
            hopIndex: this.hops,
            flatness: this.lastFlatness,
            voicePower: this.lastVoicePower,
            modFraction: this.lastModFraction,
            harmonicity: this.lastHarmonicity,
            warm: this.warm
          });
        }
      }
    }
  }

  _hop() {
    const c = this.cfg;
    // Oldest sample sits at histPos (the write cursor has wrapped past it).
    let p = this.histPos;
    for (let i = 0; i < c.fftSize; i++) {
      this.re[i] = (this.hist[p] / 32768) * this.win[i];
      this.im[i] = 0;
      p = (p + 1) % c.fftSize;
    }
    this.fft(this.re, this.im);

    let sum = 0, logSum = 0;
    const cnt = this.vHi - this.vLo + 1;
    for (let k = this.vLo; k <= this.vHi; k++) {
      const pw = this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-20;
      sum += pw;
      logSum += Math.log(pw);
    }
    // Spectral flatness: geometric mean / arithmetic mean. Near 0 = one tone
    // dominates (carrier/birdie). Near 1 = noise-like.
    this.lastFlatness = Math.exp(logSum / cnt) / (sum / cnt);
    this.lastVoicePower = sum;

    this.lastHarmonicity = this._harmonicity();

    this.env[this.envPos] = Math.sqrt(sum);
    this.envPos = (this.envPos + 1) % c.envFftSize;
    if (this.envFill < c.envFftSize) this.envFill++;

    this.hops++;
    if (this.warm) this.lastModFraction = this._modFraction();
  }

  /**
   * Peak normalised autocorrelation across the pitch range.
   *
   * ~0.4% of one core per channel measured -- cheap enough to run every hop,
   * which I assumed it was not until I measured it.
   */
  _harmonicity() {
    const c = this.cfg;
    const n = this.harmLen;
    // Newest n samples: histPos is the write cursor, so walk back from it.
    let p = this.histPos - n;
    while (p < 0) p += c.fftSize;
    let e0 = 0;
    for (let i = 0; i < n; i++) {
      const v = (this.hist[p] / 32768) * this.harmWin[i];
      this.harmBuf[i] = v;
      e0 += v * v;
      if (++p === c.fftSize) p = 0;
    }
    if (e0 < 1e-9) return 0;

    let best = 0, bestLag = 0;
    for (let lag = this.lagLo; lag <= this.lagHi; lag++) {
      let s = 0, n2 = 0;
      for (let k = 0; k + lag < n; k++) {
        s += this.harmBuf[k] * this.harmBuf[k + lag];
        n2 += this.harmBuf[k + lag] * this.harmBuf[k + lag];
      }
      const r = s / (Math.sqrt(e0 * n2) + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }

    const pitch = bestLag ? c.sampleRate / bestLag : 0;
    this.lastPitchHz = pitch;
    this.lastMainsLocked = false;

    // Only record pitches from hops that actually looked periodic. Including
    // noise-driven hops fills the history with scatter and the spread never
    // reads as steady -- measured: 126 hops all at exactly 120.0 Hz, and the
    // stability test fired on none of them.
    if (best >= c.pitchTrackMinCorr && pitch > 0) {
      this.pitchHist[this.pitchPos] = pitch;
      this.pitchPos = (this.pitchPos + 1) % this.pitchHist.length;
      if (this.pitchFill < this.pitchHist.length) this.pitchFill++;

      if (this._onMainsHarmonic(pitch) && this._pitchTooSteady()) {
        this.lastMainsLocked = true;
        return 0;                     // machine hum, not a voice
      }
    }
    return best;
  }

  /** Is this pitch within tolerance of a 50 or 60 Hz harmonic? */
  _onMainsHarmonic(pitch) {
    const c = this.cfg;
    for (const base of c.mainsHz) {
      for (let h = 1; h * base <= c.pitchHz[1] + c.mainsTolHz; h++) {
        if (Math.abs(pitch - h * base) <= c.mainsTolHz) return true;
      }
    }
    return false;
  }

  /**
   * Relative spread of recent pitch. Human speech wanders (measured 0.842 on a
   * real EAM); mains hum does not (0.020).
   */
  _pitchTooSteady() {
    if (this.pitchFill < this.pitchHist.length) return false;
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let i = 0; i < this.pitchFill; i++) {
      const v = this.pitchHist[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    const mean = sum / this.pitchFill;
    if (mean <= 0) return false;
    return ((hi - lo) / mean) < this.cfg.mainsMaxSpread;
  }

  _modFraction() {
    const n = this.cfg.envFftSize;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.env[i];
    mean /= n;

    // Read oldest-to-newest so the window is time-ordered.
    let p = this.envPos;
    for (let i = 0; i < n; i++) {
      this.eRe[i] = (this.env[p] - mean) * this.envWin[i];
      this.eIm[i] = 0;
      p = (p + 1) % n;
    }
    this.envFft(this.eRe, this.eIm);

    let band = 0, total = 0;
    for (let k = 1; k < n / 2; k++) {
      const pw = this.eRe[k] * this.eRe[k] + this.eIm[k] * this.eIm[k];
      total += pw;
      if (k >= this.mLo && k <= this.mHi) band += pw;
    }
    return total > 0 ? band / total : 0;
  }

  reset() {
    this.hist.fill(0); this.histFill = 0; this.histPos = 0; this.sinceHop = 0;
    this.env.fill(0); this.envPos = 0; this.envFill = 0;
    this.hops = 0;
    this.lastFlatness = 0; this.lastVoicePower = 0; this.lastModFraction = 0;
    this.lastHarmonicity = 0;
    this.pitchHist.fill(0); this.pitchPos = 0; this.pitchFill = 0;
    this.lastPitchHz = 0; this.lastMainsLocked = false;
  }
}

/** Offline convenience: whole-signal features, for calibration and tests. */
/**
 * Whole-signal summary for calibration and tests.
 *
 * Reports percentiles and dip fractions, NOT just medians. A median over a
 * whole capture averaged two seconds of real speech into fifteen seconds of
 * static and reported it as noise -- that mistake cost an evening.
 */
function analyseBuffer(samples, cfg) {
  const fe = new FeatureExtractor(cfg);
  const mods = [], flats = [], harms = [];
  fe.process(samples, (f) => {
    flats.push(f.flatness);
    harms.push(f.harmonicity);
    if (f.warm) mods.push(f.modFraction);
  });
  const sorted = (a) => Array.from(a).sort((x, y) => x - y);
  const pct = (a, p) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
  const fracBelow = (a, t) => (a.length ? a.filter((v) => v < t).length / a.length : 0);
  const fracAbove = (a, t) => (a.length ? a.filter((v) => v > t).length / a.length : 0);

  return {
    hops: fe.hops,
    medianFlatness: pct(flats, 0.5),
    flatnessP10: pct(flats, 0.10),
    flatnessMin: pct(flats, 0),
    // The discriminator that survived contact with real audio: how OFTEN does
    // the spectrum go peaky, not how peaky it is on average.
    flatDipFraction: fracBelow(flats, 0.30),
    medianHarmonicity: pct(harms, 0.5),
    harmonicityP90: pct(harms, 0.90),
    harmonicVoicedFraction: fracAbove(harms, 0.40),
    medianModFraction: pct(mods, 0.5),
    maxModFraction: mods.length ? Math.max.apply(null, mods) : 0,
    warmupSeconds: fe.warmupSeconds
  };
}

module.exports = {
  FeatureExtractor,
  analyseBuffer,
  makeFFT,
  hannWindow,
  DEFAULT_CFG
};
