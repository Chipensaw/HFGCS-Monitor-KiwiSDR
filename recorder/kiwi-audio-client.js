'use strict';
//
// kiwi-audio-client.js -- long-lived SND-only KiwiSDR audio session.
//
// WHY THIS IS NOT kiwi-survey/collector/kiwi-client.js
// ---------------------------------------------------
// The survey's KiwiSession is batch-shaped on purpose: connect, capture N
// waterfall windows plus one ~30 s audio grab into a fixed Int16Array, tear
// down, return a result object. Its whole contract is "visit briefly, come
// back with data."
//
// HFGCS needs the opposite lifecycle: hold one slot for ~22 minutes, stream
// audio continuously to a detector, never accumulate it, and hand off to a
// different receiver without a gap. Bending the batch class into that shape
// would leave a class that does neither job cleanly.
//
// So this module reuses the survey's *verified protocol knowledge* -- the
// exact SET sequence, frame layouts, keepalive requirements, error fields --
// and none of its session structure. Every protocol fact below was read out
// of collector/kiwi-client.js, which is validated against 176 live receivers.
//
// PROTOCOL FACTS THAT ARE EASY TO GET WRONG
// -----------------------------------------
//  * ONE session id serves BOTH sockets. Using two ids consumes two ext_api
//    channels against the sysop's declared limit instead of one.
//  * SND frames are a 10-byte header then BIG-endian int16. Little-endian
//    yields noise that looks plausible on a spectrum display.
//  * A Kiwi streams no audio until it has been tuned. Without an initial
//    SET mod/freq the SND socket stays silent forever.
//  * BOTH sockets need keepalive. An idle W/F tears the whole session down
//    and takes audio with it, observed at a metronomic ~62 s.
//  * The ws receive buffer is reused between messages. Samples must be
//    copied out before the handler returns.
//  * W/F is opened only after the first SND frame arrives.
//
// AGC IS LOAD-BEARING HERE
// ------------------------
// Bench measurement against a real 146 s EAM capture: the detector keys on
// 0.2-3 Hz envelope modulation, and an AGC decay of 100 ms is a ~1.6 Hz
// corner on the envelope that destroyed 75% of the discriminating feature
// (73.7% -> 18.8%). 2000 ms measured 74.5%, indistinguishable from no AGC at
// all. Hence decayMs >= 1000 is enforced below rather than left to config.
//
// thresh/slope/hang/manGain are the Kiwi UI defaults. They were NOT measured
// and are not claimed to be optimal -- only decay was characterised.

const WebSocket = require('ws');
const { EventEmitter } = require('events');

const SND_HEADER_BYTES = 10;
const AGC_DECAY_MS_MIN = 1000;

const DEFAULTS = {
  identUser: 'hfgcs-recorder',
  mode: 'usb',
  lowCut: 300,
  highCut: 2700,
  // A Kiwi that has not completed a WebSocket handshake in 6s is not going to.
  // 15s was costing a full quarter-minute per dead host.
  connectTimeoutMs: 6000,
  keepaliveMs: 5000,
  // If no SND frame arrives for this long the session is dead even though the
  // socket may still look open. Must be comfortably under the ~62 s idle
  // teardown so we notice before the receiver does.
  audioStallMs: 25000,
  readyTimeoutMs: 30000,
  agc: {
    enabled: 1,
    hang: 0,
    threshDb: -90,
    slopeDb: 6,
    decayMs: 2000,
    gainDb: 50
  },
  // WATERFALL IS OFF BY DEFAULT -- opening it KILLS the session.
  //
  // Measured against a live receiver, same tune, same keepalive:
  //   SND only      -> still streaming at 75s (1713 frames)
  //   SND + W/F     -> closed by the receiver at 26.1s
  //
  // The setup we send is byte-identical to the survey's, and neither sends
  // SET zoom=/start=. A waterfall socket that never asks for data looks like a
  // broken client and the Kiwi drops the WHOLE session, audio included. That
  // is the ~25s disconnect loop.
  //
  // It was only ever opened for masking detection, which is not built. Turn it
  // on again when that is, and send a zoom/start when you do.
  openWaterfall: false,
  wf: {
    speed: 1,
    maxDb: -10,
    minDb: -110
  }
};

function parseMsg(text) {
  const out = {};
  for (const tok of String(text).trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else if (tok) out[tok] = true;
  }
  return out;
}

function mergeOpts(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  o.agc = Object.assign({}, DEFAULTS.agc, (opts && opts.agc) || {});
  o.wf = Object.assign({}, DEFAULTS.wf, (opts && opts.wf) || {});
  return o;
}

/**
 * Events:
 *   'ready'  ({audioRate})            -- SND flowing and tuned
 *   'audio'  (Int16Array, meta)       -- one decoded frame, owned by receiver
 *   'meta'   ({centerFreq, bandwidth})-- from the W/F socket
 *   'error'  ({code, message})        -- terminal; 'close' always follows
 *   'close'  ({code, stats})          -- exactly once
 */
class KiwiAudioSession extends EventEmitter {
  /**
   * @param {{host:string, port:number, id?:string}} receiver
   * @param {number} freqKHz  dial frequency, kHz (e.g. 8992)
   */
  constructor(receiver, freqKHz, opts) {
    super();
    if (!receiver || !receiver.host || !receiver.port) {
      throw new Error('receiver requires host and port');
    }
    if (!Number.isFinite(freqKHz) || freqKHz <= 0) {
      throw new Error('freqKHz must be a positive number');
    }

    this.rx = receiver;
    this.freqKHz = freqKHz;
    this.opts = mergeOpts(opts);

    if (this.opts.agc.enabled && this.opts.agc.decayMs < AGC_DECAY_MS_MIN) {
      throw new Error(
        'agc.decayMs=' + this.opts.agc.decayMs + ' is below ' + AGC_DECAY_MS_MIN +
        'ms; a fast AGC destroys the 0.2-3 Hz detector feature (measured ' +
        '73.7% -> 18.8% at 100ms). Use decayMs>=1000 or agc.enabled=0.');
    }

    // One session id, both sockets. See header.
    //
    // MUST BE A PLAIN INTEGER. The Kiwi parses this path segment as a numeric
    // timestamp; give it anything else and it completes the WebSocket upgrade
    // and then silently ignores the connection -- no error, no close, no
    // messages, just a socket that sits open forever. Measured against two
    // live receivers: numeric -> 16 protocol messages, "<ts>-<rand>" -> 0.
    //
    // I added the random suffix for uniqueness. Date.now() is already unique
    // per session here because sessions are seconds apart, and uniqueness was
    // never the constraint the receiver cared about.
    this.session = String(Date.now());

    this.snd = null;
    this.wf = null;
    this.keepalive = null;
    this.stallCheck = null;
    this.readyTimer = null;

    this.closed = false;
    this.ready = false;
    this.setupSent = false;
    this.wfOpened = false;
    this.audioRate = null;
    this.errorInfo = null;

    this.stats = {
      startedAt: null,
      readyAt: null,
      frames: 0,
      samples: 0,
      bytes: 0,
      lastFrameAt: 0,
      wfFrames: 0,
      retunes: 0
    };
  }

  get endpoint() {
    return this.rx.host + ':' + this.rx.port;
  }

  // -- socket send guards ----------------------------------------------------
  _sendSnd(cmd) {
    if (this.snd && this.snd.readyState === WebSocket.OPEN) {
      try { this.snd.send(cmd); } catch (_) { /* close handler will fire */ }
    }
  }

  _sendWf(cmd) {
    if (this.wf && this.wf.readyState === WebSocket.OPEN) {
      try { this.wf.send(cmd); } catch (_) { /* close handler will fire */ }
    }
  }

  // -- lifecycle -------------------------------------------------------------
  open() {
    if (this.closed || this.snd) return this;
    this.stats.startedAt = Date.now();
    this._openSnd();

    // A receiver that accepts the socket but never streams must not hold a
    // worker forever.
    this.readyTimer = setTimeout(() => {
      if (!this.ready) this._fail('ready_timeout', 'no audio within readyTimeoutMs');
    }, this.opts.readyTimeoutMs);

    return this;
  }

  /** Retune within the same session -- cheaper and politer than reconnecting. */
  retune(freqKHz) {
    if (!Number.isFinite(freqKHz) || freqKHz <= 0) {
      throw new Error('freqKHz must be a positive number');
    }
    this.freqKHz = freqKHz;
    this.stats.retunes++;
    if (this.ready) this._sendTune();
    return this;
  }

  _sendTune() {
    this._sendSnd(
      'SET mod=' + this.opts.mode +
      ' low_cut=' + this.opts.lowCut +
      ' high_cut=' + this.opts.highCut +
      ' freq=' + this.freqKHz.toFixed(3));
  }

  close(code) {
    this._teardown(code || 'closed');
  }

  _fail(code, message) {
    if (!this.errorInfo) this.errorInfo = { code, message: message || code };
    this._teardown(code);
  }

  _teardown(code) {
    if (this.closed) return;
    this.closed = true;

    if (this.keepalive) clearInterval(this.keepalive);
    if (this.stallCheck) clearInterval(this.stallCheck);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.keepalive = this.stallCheck = this.readyTimer = null;

    for (const s of [this.wf, this.snd]) {
      if (s) { try { s.close(); } catch (_) { /* already gone */ } }
    }

    if (this.errorInfo) this.emit('error', this.errorInfo);
    this.emit('close', { code, stats: this.stats });
  }

  // -- SND -------------------------------------------------------------------
  _openSnd() {
    const url = 'ws://' + this.endpoint + '/ws/kiwi/' + this.session + '/SND';
    this.snd = new WebSocket(url, { handshakeTimeout: this.opts.connectTimeoutMs });

    this.snd.on('open', () => {
      // Public passwordless receivers only. p=# is the server's "no password"
      // token; no credential ever transits this client.
      this._sendSnd('SET auth t=kiwi p=#');
      this._sendSnd('SET ident_user=' + this.opts.identUser);
      this._sendSnd('SET compression=0');

      this.keepalive = setInterval(() => {
        this._sendSnd('SET keepalive');
        // Only meaningful when the waterfall is open; _sendWf is a no-op
        // otherwise. Keepalive alone does NOT save a W/F session -- measured.
        if (this.opts.openWaterfall) this._sendWf('SET keepalive');
      }, this.opts.keepaliveMs);
    });

    this.snd.on('message', (data, isBinary) => {
      if (this.closed) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 3) return;
      const tag = buf.toString('latin1', 0, 3);

      if (tag === 'MSG' || !isBinary) {
        this._handleSndText(tag === 'MSG' ? buf.toString('utf8', 3) : buf.toString());
        return;
      }
      if (tag !== 'SND') return;

      if (this.opts.openWaterfall && !this.wfOpened) this._openWf();

      if (buf.length <= SND_HEADER_BYTES) return;

      const n = (buf.length - SND_HEADER_BYTES) >> 1;
      if (n <= 0) return;

      // Copy out: the ws receive buffer is reused between messages.
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        pcm[i] = buf.readInt16BE(SND_HEADER_BYTES + i * 2);
      }

      this.stats.frames++;
      this.stats.samples += n;
      this.stats.bytes += buf.length;
      this.stats.lastFrameAt = Date.now();

      if (!this.ready) {
        this.ready = true;
        this.stats.readyAt = this.stats.lastFrameAt;
        if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
        this._startStallWatch();
        this.emit('ready', { audioRate: this.audioRate });
      }

      this.emit('audio', pcm, {
        sampleRate: this.audioRate,
        freqKHz: this.freqKHz,
        at: this.stats.lastFrameAt
      });
    });

    this.snd.on('error', (e) => this._fail('snd_error', e.message));
    this.snd.on('close', () => {
      if (!this.closed) this._fail('snd_closed', 'SND socket closed');
    });
  }

  _handleSndText(text) {
    const f = parseMsg(text);

    // Slot exhaustion / IP cap. Abandon immediately; never retry into it.
    if (f.ip_limit !== undefined) {
      return this._fail('ip_limit', 'receiver reports ip_limit');
    }
    if (f.too_busy !== undefined) {
      return this._fail('too_busy', 'receiver reports too_busy');
    }

    if (f.audio_rate !== undefined && !this.setupSent) {
      this.setupSent = true;
      this.audioRate = parseInt(f.audio_rate, 10) || 12000;

      this._sendSnd('SET AR OK in=' + this.audioRate + ' out=24000');
      this._sendSnd('SERVER DE CLIENT ' + this.opts.identUser + ' SND');
      this._sendSnd('SET squelch=0');       // squelch is ours to do, not the Kiwi's
      this._sendSnd('SET genattn=0');
      this._sendSnd('SET gen=0 mix=-1');

      const g = this.opts.agc;
      this._sendSnd('SET agc=' + g.enabled + ' hang=' + g.hang +
                    ' thresh=' + g.threshDb + ' slope=' + g.slopeDb +
                    ' decay=' + g.decayMs + ' manGain=' + g.gainDb);

      // Without this the SND socket stays silent forever.
      this._sendTune();
      this._sendSnd('SET keepalive');
    }
  }

  _startStallWatch() {
    this.stallCheck = setInterval(() => {
      if (this.closed) return;
      const gap = Date.now() - this.stats.lastFrameAt;
      if (gap > this.opts.audioStallMs) {
        this._fail('audio_stall', 'no SND frame for ' + gap + 'ms');
      }
    }, Math.max(1000, Math.floor(this.opts.audioStallMs / 4)));
  }

  // -- W/F -------------------------------------------------------------------
  // Kept open for two reasons: an idle W/F tears down the session, and the
  // spectrum it carries is what will later distinguish a masked HFGCS channel
  // from a genuinely quiet one. At wf_speed=1 it costs ~1 kB/s.
  _openWf() {
    if (this.wfOpened || this.closed) return;
    this.wfOpened = true;

    const url = 'ws://' + this.endpoint + '/ws/kiwi/' + this.session + '/W/F';
    this.wf = new WebSocket(url, { handshakeTimeout: this.opts.connectTimeoutMs });

    this.wf.on('open', () => {
      this._sendWf('SET auth t=kiwi p=#');
      this._sendWf('SET ident_user=' + this.opts.identUser);
      this._sendWf('SET compression=0');
      this._sendWf('SET wf_comp=0');       // audio `compression` does not cover W/F
      this._sendWf('SET send_dB=1');
      this._sendWf('SET maxdb=' + this.opts.wf.maxDb + ' mindb=' + this.opts.wf.minDb);
      this._sendWf('SET wf_speed=' + this.opts.wf.speed);
    });

    this.wf.on('message', (data) => {
      if (this.closed) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 3) return;
      const tag = buf.toString('latin1', 0, 3);

      if (tag === 'MSG') {
        const f = parseMsg(buf.toString('utf8', 3));
        if (f.ip_limit !== undefined) {
          return this._fail('ip_limit', 'receiver reports ip_limit');
        }
        if (f.too_busy !== undefined) {
          return this._fail('too_busy', 'receiver reports too_busy');
        }
        const c = Number(f.center_freq);
        const b = Number(f.bandwidth);
        if (Number.isFinite(c) && Number.isFinite(b) && b > 0) {
          this.emit('meta', { centerFreq: c, bandwidth: b });
        }
        return;
      }
      if (tag === 'W/F') this.stats.wfFrames++;
    });

    // A dead W/F is not fatal to audio as long as we keep the SND keepalive
    // going, so this degrades rather than killing the session. It does mean
    // masking detection is unavailable for the rest of the session.
    this.wf.on('error', () => { this.wf = null; });
    this.wf.on('close', () => { this.wf = null; });
  }
}

module.exports = {
  KiwiAudioSession,
  parseMsg,
  SND_HEADER_BYTES,
  AGC_DECAY_MS_MIN,
  DEFAULTS
};
