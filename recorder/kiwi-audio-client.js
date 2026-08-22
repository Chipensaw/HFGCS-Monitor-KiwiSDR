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

// -- Waterfall protocol -----------------------------------------------------
// Ported from kiwi-survey/collector/kiwi-client.js, where every one of these
// was verified against live receivers rather than inferred. Do not "simplify"
// them without re-measuring.
//
//   * ONE session id serves BOTH sockets. The Kiwi keys an rx channel by it, so
//     SND + W/F on one id cost ONE channel against the sysop's declared limit.
//   * BOTH sockets need their own keepalive; an idle W/F tears down the whole
//     session and takes audio with it.
//   * Frames are 1040 bytes: 16-byte header then 1024 one-byte bins.
//     Header: 'W/F' + 0x20, start LE u32 @4, zoom u8 @8, 3 pad, counter @12.
//   * dBm = byte - 255 when send_dB=1. maxdb/mindb govern browser display only.
//   * `start` is a 24-bit fixed-point LOW-EDGE OFFSET across the receiver's full
//     bandwidth, NOT a bin index.
//   * Receivers may send compressed rows at higher zoom regardless of wf_comp=0.
//     We detect those by length and skip them rather than misread them.
//
// And the one this project learned the hard way: a W/F socket opened WITHOUT
// `SET zoom=/start=` gets the entire session torn down. Measured on a live
// receiver: without it the audio socket closed at 20.3 s having delivered zero
// waterfall frames; with it, 90 s and still streaming, 88 frames received.
const WF_BINS = 1024;
const WF_HEADER_BYTES = 16;
const WF_FRAME_BYTES = WF_HEADER_BYTES + WF_BINS;   // 1040
const WF_ADPCM_FRAME_BYTES = 533;                   // compressed: skip
const WF_START_MAX = (2 ** 24) - 1;
const WF_ZOOM_HARD_CAP = 20;

/**
 * Highest zoom whose segment still fully contains the requested view.
 */
function computeZoomStart(view, span, zoomCap) {
  if (!view || !span || !span.fullBandwidthHz) return null;
  const cap = Math.min(
    Number.isFinite(zoomCap) ? zoomCap : WF_ZOOM_HARD_CAP, WF_ZOOM_HARD_CAP);
  const { fullLowHz, fullBandwidthHz } = span;
  const startFor = (lowHz) =>
    Math.round(((lowHz - fullLowHz) / fullBandwidthHz) * (WF_START_MAX + 1));

  for (let z = Math.max(0, cap); z >= 0; z--) {
    const rowSpan = fullBandwidthHz / Math.pow(2, z);
    const mid = (view.lowHz + view.highHz) / 2;
    let segLow = mid - rowSpan / 2;
    if (segLow < fullLowHz) segLow = fullLowHz;
    if (segLow + rowSpan > fullLowHz + fullBandwidthHz) {
      segLow = fullLowHz + fullBandwidthHz - rowSpan;
    }
    if (segLow <= view.lowHz && segLow + rowSpan >= view.highHz) {
      const start = startFor(segLow);
      if (!Number.isFinite(start)) return null;
      return {
        zoom: Math.max(0, Math.min(z, WF_ZOOM_HARD_CAP)),
        start: Math.max(0, Math.min(start, WF_START_MAX)),
        segLowHz: segLow,
        rowSpanHz: rowSpan,
        binHz: rowSpan / WF_BINS
      };
    }
  }
  return {
    zoom: 0, start: 0,
    segLowHz: fullLowHz, rowSpanHz: fullBandwidthHz,
    binHz: fullBandwidthHz / WF_BINS
  };
}

const DEFAULTS = {
  identUser: 'hfgcs-recorder',
  // Sent as the HTTP User-Agent on the WebSocket upgrade. The receiver's user
  // list shows identUser; this is the other place a sysop might look, and it
  // was configured but never actually sent -- the ws client does not set a
  // custom header unless told to, so connections carried the Node default.
  //
  // The +URL is the important part: it is public, needs no password, explains
  // what the tool does, and has an Issues tab. That one link is both the
  // "what is this" answer and a reachable opt-out route.
  userAgent: 'HFGCS-Monitor-KiwiSDR/0.1 (+https://github.com/Chipensaw/HFGCS-Monitor-KiwiSDR)',
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
  // Now safe to enable: the missing zoom/start was the whole cause of the
  // teardown. Off by default still, so a caller opts in per session.
  openWaterfall: false,
  wf: {
    // Measured row rate on a live receiver: speed 1 -> 0.99 rows/s, speed 2 ->
    // 4.88 rows/s (3 and 4 were SLOWER, apparently rate-limited).
    //
    // At 1 row/s a 20 s capture yields ~20 rows to fill a 144-row image, so
    // each row is repeated seven times and the thumbnail is a blocky ladder.
    //
    // The cost is real and belongs in ETIQUETTE.md: ~5 KB/s per session rather
    // than ~1 KB/s. Still small against the audio stream, but it is somebody
    // else's bandwidth.
    speed: 2,
    maxDb: -10,
    minDb: -110,
    // Half-width of the view to request around the tuned frequency. 12 kHz puts
    // a 3 kHz SSB signal in about an eighth of the row -- the narrow-band-in-
    // context look the audio spectrogram cannot produce.
    viewHalfWidthHz: 12000,
    // Rows kept in memory. At ~4.9 rows/s this is ~3 minutes of history, which
    // covers the longest captures seen so far (170 s). 1 KB per row, so ~900 KB
    // per channel -- affordable on a 945 MB box.
    maxRows: 900
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
    this.span = null;          // {fullLowHz, fullBandwidthHz} from the receiver
    this.zoomCap = null;
    this.wfView = null;        // the zoom/start actually requested
    this.wfRows = [];          // rolling ring of decoded rows
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
      wfCompressed: 0,
      retunes: 0
    };
  }

  get endpoint() {
    return this.rx.host + ':' + this.rx.port;
  }

  /**
   * WebSocket options, shared by both sockets.
   * An undefined header value breaks the upgrade, so it is omitted entirely
   * rather than sent empty.
   */
  _wsOpts() {
    const o = { handshakeTimeout: this.opts.connectTimeoutMs };
    if (this.opts.userAgent) o.headers = { 'User-Agent': this.opts.userAgent };
    return o;
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
    this.snd = new WebSocket(url, this._wsOpts());

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
  /**
   * Ask for the view we actually want. Needs the receiver's span, which arrives
   * as center_freq/bandwidth on the W/F socket, so this is called again once
   * that lands.
   */
  _sendWfView() {
    if (!this.span || !this.wf || this.wf.readyState !== WebSocket.OPEN) return false;
    const half = this.opts.wf.viewHalfWidthHz;
    const hz = this.freqKHz * 1000;
    const zs = computeZoomStart({ lowHz: hz - half, highHz: hz + half }, this.span, this.zoomCap);
    if (!zs) return false;
    this.wfView = zs;
    this._sendWf('SET zoom=' + zs.zoom + ' start=' + zs.start);
    return true;
  }

  /**
   * One waterfall row. Compressed rows are SKIPPED rather than misread: some
   * receivers switch to them at higher zoom regardless of wf_comp=0, and a
   * misdecoded row is worse than a missing one.
   */
  _onWfFrame(buf) {
    if (buf.length === WF_ADPCM_FRAME_BYTES) { this.stats.wfCompressed++; return; }
    if (buf.length !== WF_FRAME_BYTES) return;
    this.stats.wfFrames++;
    const bins = Buffer.allocUnsafe(WF_BINS);
    buf.copy(bins, 0, WF_HEADER_BYTES);
    // The header names the view the receiver is CURRENTLY serving: start as a
    // LE u32 @4, zoom @8. Keeping them lets a caller that MOVES the view match
    // each row to the segment it actually belongs to. Measured on air
    // 2026-08-22: two rows for the PREVIOUS segment still arrive after a
    // SET zoom=/start=, so a ring that only knows "the current view" mislabels
    // them -- silently, at a plausible level and the wrong frequency.
    this.wfRows.push({
      at: Date.now(),
      zoom: buf.readUInt8(8),
      start: buf.readUInt32LE(4),
      bins
    });
    if (this.wfRows.length > this.opts.wf.maxRows) this.wfRows.shift();
  }

  /** Rows overlapping a time window, with the geometry to label the axis. */
  waterfallRows(fromMs, toMs) {
    if (!this.wfView || !this.wfRows.length) return null;
    const rows = this.wfRows.filter((r) => r.at >= fromMs && r.at <= toMs);
    if (rows.length < 2) return null;
    return {
      rows: rows.map((r) => r.bins),
      segLowHz: this.wfView.segLowHz,
      rowSpanHz: this.wfView.rowSpanHz,
      binHz: this.wfView.binHz,
      zoom: this.wfView.zoom,
      freqKHz: this.freqKHz
    };
  }

  /**
   * Point the WATERFALL at an explicit view, mid-session.
   *
   * retune() moves the SND channel and leaves the W/F where it was; this is
   * the other half, and they are deliberately separate. A sweeper walks
   * segments without retuning the audio at all.
   *
   * Returns the resolved view, or null if the span has not arrived yet, the
   * socket is not open, or the view cannot be resolved.
   */
  setWaterfallView(view) {
    if (!this.span) return null;
    if (!this.wf || this.wf.readyState !== WebSocket.OPEN) return null;
    const zs = computeZoomStart(view, this.span, this.zoomCap);
    if (!zs) return null;
    this.wfView = zs;
    this._sendWf('SET zoom=' + zs.zoom + ' start=' + zs.start);
    return zs;
  }

  /**
   * Rows belonging to ONE view, labelled with THAT view's geometry.
   *
   * waterfallRows() labels every row with whatever wfView is current, which is
   * correct only for a session that never moves the view -- as the recorder
   * does not. A caller that DOES move it must use this instead.
   *
   * The ring is deliberately NOT cleared on a view change. Rows carry their
   * own zoom/start, so stale ones are excluded by identity rather than by a
   * timer; and leaving them in place lets a sweeper count how many arrived
   * late, which is the only cheap check that the header is tracking the view
   * at all. Clearing would make that count always zero and hide a regression.
   */
  waterfallRowsForView(view, fromMs, toMs) {
    if (!view || !this.wfRows.length) return null;
    const from = fromMs === undefined ? -Infinity : fromMs;
    const to = toMs === undefined ? Infinity : toMs;
    const rows = this.wfRows.filter((r) =>
      r.at >= from && r.at <= to && r.zoom === view.zoom && r.start === view.start);
    if (!rows.length) return null;
    return {
      rows: rows.map((r) => r.bins),
      segLowHz: view.segLowHz,
      rowSpanHz: view.rowSpanHz,
      binHz: view.binHz,
      zoom: view.zoom,
      start: view.start,
      freqKHz: this.freqKHz
    };
  }

  _openWf() {
    if (this.wfOpened || this.closed) return;
    this.wfOpened = true;

    const url = 'ws://' + this.endpoint + '/ws/kiwi/' + this.session + '/W/F';
    this.wf = new WebSocket(url, this._wsOpts());

    this.wf.on('open', () => {
      this._sendWf('SET auth t=kiwi p=#');
      this._sendWf('SET ident_user=' + this.opts.identUser);
      this._sendWf('SET compression=0');
      this._sendWf('SET wf_comp=0');       // audio `compression` does not cover W/F
      this._sendWf('SET send_dB=1');
      this._sendWf('SET maxdb=' + this.opts.wf.maxDb + ' mindb=' + this.opts.wf.minDb);
      this._sendWf('SET wf_speed=' + this.opts.wf.speed);

      // THE COMMAND THAT MATTERS. A waterfall socket that never asks for data
      // looks like a broken client and the receiver tears down the WHOLE
      // session, audio included. Measured: without this, SND closed at 20.3 s
      // with zero W/F frames; with it, 90 s and still streaming.
      this._sendWfView();
      this._sendWf('SET keepalive');
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
        if (f.zoom_cap !== undefined) {
          const z = Number(f.zoom_cap);
          if (Number.isFinite(z)) this.zoomCap = z;
        }
        const c = Number(f.center_freq);
        const b = Number(f.bandwidth);
        if (Number.isFinite(c) && Number.isFinite(b) && b > 0) {
          this.span = { fullLowHz: c - b / 2, fullBandwidthHz: b };
          this.emit('meta', { centerFreq: c, bandwidth: b });
          // The view could not be computed before this arrived, so ask now.
          if (!this.wfView) this._sendWfView();
        }
        return;
      }
      if (tag === 'W/F') return this._onWfFrame(buf);
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
  computeZoomStart,
  WF_BINS,
  WF_HEADER_BYTES,
  WF_FRAME_BYTES,
  WF_ADPCM_FRAME_BYTES,
  WF_START_MAX,
  parseMsg,
  SND_HEADER_BYTES,
  AGC_DECAY_MS_MIN,
  DEFAULTS
};
