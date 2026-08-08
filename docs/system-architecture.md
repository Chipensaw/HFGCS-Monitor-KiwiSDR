# HFGCS Monitor -- System Architecture

Status: **current** -- verified 2026-08-08 against deployed code on
`onlineremoteradio` (`/opt/hfgcs/`).

This is the **architecture spine**. It describes how the system is built: the
three-process topology, the config contract everything rides on, the session
model, and the data files each process owns. Detector thresholds and the
evidence behind them live in `detector-calibration.md`; receiver-facing
behaviour lives in `../ETIQUETTE.md`; traps and open work live in
`../HANDOFF.md`. When a feature doc and this spine disagree, the feature doc
owns the detail.

---

## 1. Purpose

A recorder that watches HFGCS voice frequencies through publicly listed KiwiSDR
receivers, detects speech, writes captures with pre-roll, and publishes them to
an operator page and a public page. It owns no radio hardware. Every byte of
audio arrives over somebody else's internet connection from somebody else's
receiver, and that fact shapes most of the design.

---

## 2. Three processes, deliberately separate

```
   hfgcs-recorder --------------> data/          <------ hfgcs-monitor  (8898)
   one worker per frequency        events/<day>/          operator page, AUTHED
   SND + W/F per session           *.wav *.png            settings, labels, delete
   detector, thumbnails            events.jsonl           holds a sudo grant
                                   index.json
                                   labels.jsonl    <------ hfgcs-public  (8897)
                                   status.json             public page, NO AUTH
                                   coverage.jsonl          read-only, GET/HEAD only
                                   delete-log.jsonl        no sudo, no write paths
```

**Why three and not one.** The operator monitor can start and stop the recorder
through a sudo grant, and can write config, labels and delete captures. The
public page is exposed to the internet without authentication. Serving both from
one process would put that sudo grant one routing mistake away from a stranger.
`monitor/public.js` is a separate handler with no control routes at all -- not
the operator page with the buttons hidden, because "hidden" is not "absent" and
a stray `fetch()` would still reach a live endpoint.

nginx terminates TLS and proxies:

| path | to | auth |
|---|---|---|
| `/hfgcs/` | 127.0.0.1:8898 | basic auth |
| `/hfgcs-public/` | 127.0.0.1:8897 | none, rate-limited |

Both bind loopback only. Neither is reachable except through nginx.

---

## 3. The config contract  (the thing that bit twice)

`config/hfgcs.json` -> `buildConfig()` in `recorder/index.js` -> every component.

**Every key passes through. There is no whitelist.**

This is not a stylistic preference. `buildConfig` originally forwarded detector
settings through a hand-maintained list of eleven names. Three settings added
later -- `minVoicedFraction`, `harmVoicedThreshold`, `trailingSeconds` -- were
read from the file, shown in the settings page, saved correctly when changed,
and then silently dropped before reaching the detector, which kept its built-in
defaults. The operator changed a threshold across several restarts and nothing
happened, with no error anywhere. The session-options block had the same shape
and would have swallowed `openWaterfall` the same way.

Both now forward everything, excluding only `_`-prefixed comment keys and
`undefined` values, with the two deliberate renames (`frameSamples` -> `fftSize`,
`hopSamples` -> `hop`) special-cased. A generic test asserts that every key the
detector knows about survives the trip.

> **Rule:** any explicit key list between config and consumer is a defect
> waiting to happen. If you add a setting, it should work without editing a
> passthrough.

Settings take effect **on the next recorder start**, never live. The page says
so; the recorder reads config once at startup.

---

## 4. Session model

One `ChannelWorker` per active frequency. Receivers rotate underneath a worker;
the worker owns the frequency, the receiver is interchangeable.

### 4.1 Two sockets, one session id

```
   SND  ws://host:port/ws/kiwi/<sessionId>/SND    12 kHz PCM audio
   W/F  ws://host:port/ws/kiwi/<sessionId>/W/F    ~29 kHz RF spectrum rows
```

The session id **must be a plain integer**. Anything else and the receiver
completes the WebSocket upgrade then silently ignores the connection: no error,
no close, no bytes. Measured on two hosts -- numeric gave 16 protocol messages,
`<ts>-<rand>` gave zero.

**One id serves both sockets**, so SND + W/F consume ONE rx channel against the
sysop's declared slot count, not two.

**Both sockets need their own keepalive.** An idle W/F tears down the whole
session and takes the audio with it.

**The W/F socket must send `SET zoom=/start=`.** Without it the receiver drops
everything at ~20 s. Measured: 20.3 s and zero waterfall frames without, 90 s
and still streaming with. This looked like a receiver quirk and was entirely a
client bug.

### 4.2 Rotation is make-before-break

The next receiver is opened and confirmed streaming before the current one is
released. The brief two-slot overlap is across *different* receivers, so no
sysop ever sees us holding two.

**Every path that abandons a connection attempt must re-arm the rotation
timer.** `_retryLater()` deliberately does nothing while a session is current,
so a failed *rotation* -- as opposed to a failed initial connect -- would
silently disable rotation for that channel. Observed live: a rotation target hit
`ready_timeout` and the worker then held one receiver for 124 minutes against a
22-minute cap, looking perfectly healthy because audio kept flowing. Four paths
can abandon an attempt (failed target, probe exhaustion, session construction,
`open()` throwing) and all four re-arm.

---

## 5. Signal path

```
  kiwi-audio-client   SND frames: 10-byte header, then BIG-endian int16
         |            W/F frames: 1040 bytes = 16-byte header + 1024 bins,
         |                        dBm = byte - 255
         v
  ring-buffer         60 s ring, PRE-ROLL ONLY
         |            (an earlier version extracted finished events from the
         |             ring, which silently capped event length at ring
         |             capacity -- a 600 s event lost its first 540 seconds)
         v
  detector/features   flatness, 0.2-3 Hz modulation, harmonicity (pitch
         |            autocorrelation 70-300 Hz), mains-harmonic rejection
         v
  detector/voice-detector   two-stage gate, hangover, conservative trim
         |
         v
  recorder/encoder    streams to WAV from the moment of trigger
         |
         v
  recorder/spectrogram   waterfall PNG: RF rows preferred, audio FFT fallback
```

### 5.1 Detection, in one paragraph

Spectral flatness rejects carriers outright. Then a **voicing** test -- what
fraction of a rolling ~5.5 s window shows periodic pitch in the 70-300 Hz range
-- decides. Real static has no periodic voicing; speech does, even when weak.
The 0.2-3 Hz modulation test is still in the trigger path and **does not
discriminate on real HF**; it was fitted against synthetic white noise and is
retained only because voicing carries the decision. See
`detector-calibration.md`.

Mains hum is periodic at 100/120/150/180 Hz and autocorrelation cannot tell it
from a voice by strength. The discriminator is **stability**: human pitch wanders
(measured spread 0.842), grid hum does not (0.020).

### 5.2 The trim, and why it is conservative

When the hangover expires, only the **current unbroken quiet run** is removed.
Two earlier versions cut into live audio: subtracting `hangoverSeconds` blindly
assumed the window was silent, and trimming back to the last *voiced* hop was
worse -- a real 34 s event was cut to 18.7 s, discarding audible speech which
then re-triggered as a second file with a seamless join. Trailing static is a
far cheaper mistake than lost transmission.

---

## 6. Site selection

`scheduler/select.js`: **filter, then rank.**

Filter (etiquette and capability): `usersMax >= 4`, non-proxied, band coverage,
not blocklisted, not cooling down after a failure.

Rank: propagation (solar geometry), survey quality from the Kiwi-SNR-Surveyor
cohort, mains penalty, ADC-overflow penalty, recent-use penalty, and an optional
region preference.

`pick()` draws **randomly from the top N**, not the single best -- so tests that
assume an ordering are flaky, and load spreads across good receivers rather than
hammering one.

**Connect failures expire after 30 minutes.** One-strike-permanent retirement
drained the whole eligible pool, `bestPropagation()` returned 0, and the
propagation gate mistook an exhausted pool for a closed band and parked every
channel indefinitely. The gate now distinguishes "band closed" from "no eligible
receivers (N cooling)" -- different problems, same score of zero.

`scheduler/stations.json` holds the 13 HFGCS ground stations with coordinates
and the summer UDXF schedule. The public map uses it. **Site selection does not
yet use it** -- path midpoints remain unbuilt, and receiver choice is still solar
geometry plus region preference.

---

## 7. Data files, and who owns them

| file | writer | notes |
|---|---|---|
| `events/<day>/*.wav` | recorder | the capture |
| `events/<day>/*.png` | recorder | waterfall thumbnail |
| `events/<day>/events.jsonl` | recorder | append-only, one record per capture |
| `index.json` | recorder | rolling index the pages read |
| `status.json` | recorder | live channel state |
| `coverage.jsonl` | recorder | hourly monitored-time accounting; **nothing displays it** |
| `labels.jsonl` | monitor | append-only voice/static/data/unsure |
| `delete-log.jsonl` | monitor | what was deleted, when, by which IP |

**One-writer rule, enforced by code not by the filesystem.** The recorder owns
`events.jsonl`; the monitor owns labels and the delete log. The monitor has
write access to `data/` because settings, labelling and delete need it, so this
is weaker than it looks -- worth remembering if anything starts appending.

### 7.1 Capture record

Every record carries the audio path, timing, receiver identity and position,
the detector state at trigger, and a full post-hoc feature vector for offline
threshold work. Two fields are easy to confuse:

- `voicedAtTrigger` / `peakVoicedFraction` -- the **rolling-window** value the
  gate actually tested. Directly comparable to `minVoicedFraction`.
- `features.harmonicVoicedFraction` -- the **whole-file average**, which folds
  in pre-roll and every inter-word pause and therefore reads far lower.

Showing the second against a threshold that tests the first made a legitimate
capture look like a violation: triggered at 21.5%, displayed 8.4%, configured
minimum 15%. The pages show the gated value.

### 7.2 Deletion is permanent

Captures are unlinked, along with their thumbnails. There is no holding area.
The previous `data/trash/` was unreachable from any page, served by no route,
and never pruned by retention -- it reached 521 files and 481 MB while the
confirmation dialog told operators the files were recoverable. Both halves were
untrue. Either wire a recovery path or delete outright; the half-measure cost
disk and misled the user.

Retention prunes `events/` by age and total size on a daily timer.

---

## 8. Thumbnails

`recorder/spectrogram.js` writes a PNG beside every capture: frequency across,
time downward, jet palette -- the orientation and colours a KiwiSDR itself
shows, because a familiar picture is worth more than an original one.

**RF preferred, audio fallback.** With the W/F socket available the thumbnail is
real radio spectrum, ~29 kHz wide, so a 3 kHz transmission is a narrow band in
context and it becomes visible when a detection is actually a strong neighbour
bleeding into the passband. Without it, an FFT of the demodulated audio, which
can never exceed 6 kHz. Each record notes which in `thumbSource`.

Three constraints learned by measurement:

- **Average every frame in a row's time span.** Taking one FFT per row and
  skipping the audio between rendered 9.9% of a 103 s capture and produced harsh
  striping that looked like signal structure and was pure aliasing.
- **Render at the height the data supports**, never taller. Stretching 20 rows
  over 144 pixels repeats each seven times.
- **Hold a minimum dB span open.** Auto-scaling to the range present is right
  when a signal exists and wrong when one does not: an empty channel has only
  ~10 dB of receiver noise variation, and stretching that across the ramp paints
  a full-frame rainbow that reads as activity.

The PNG encoder is hand-rolled against `zlib` -- no canvas, sharp or pngjs on
the box, and pulling a native image library in to draw a 360x144 image was not a
trade worth making.

---

## 9. Interlocks

`bin/preflight.sh` runs as `ExecStartPre` and refuses to start unless:

1. `config/ENABLED` exists -- **installing is not authorising**
2. `kiwi-survey-collector` is not active -- both draw from the same Kiwi pool
3. the newest survey run carries its `COMPLETE` sentinel

Gates 2 and 3 exist because a slot we hold is a slot the survey sees as
unavailable, feeding its selection bias from the inside where its cohort
fingerprint cannot detect it.

`ENABLED` is deliberately **not reachable from the web page**. It is the
authorisation to contact other people's receivers and stays a shell act.

`hfgcs-recorder` ships `disabled` in systemd: it will not return after a reboot
without a deliberate start. That is correct for a supervised phase and costs a
night of captures when the box restarts unattended -- a trade to revisit, not a
bug.

---

## 10. Where the console links in

`console.html` and `consolebeta.html` (in `/var/www/flex-radio-v2/`, a different
repo) carry an **HFGCS ^** button in the decoders panel opening
`/hfgcs-public/`.

It uses `.decoder-link-btn`, **not** `.decoder-mode-btn`. `updateModeButtons()`
disables every `.decoder-mode-btn` whose `data-mode` does not match the running
decoder, so the link would have greyed out whenever any decoder was running and
looked like an intermittent fault.

---

## 11. Cross-references

- `detector-calibration.md` -- what the thresholds rest on, and what they do not
  establish. Note that the source audio has been deleted; the measurements are
  history and cannot be re-run.
- `../ETIQUETTE.md` -- what we ask of volunteer receivers and why, including the
  waterfall's bandwidth cost.
- `../HANDOFF.md` -- known holes, open work, and the operational lessons.
