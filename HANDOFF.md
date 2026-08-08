# Handoff

State as of 2026-07-31. Read this if you are picking the project up cold.
Detector measurements live in [docs/detector-calibration.md](docs/detector-calibration.md);
receiver-facing behaviour in [ETIQUETTE.md](ETIQUETTE.md).

Built in one session, 2026-07-30/31. Nothing existed before that date.

---

## Deployment shape

Runs as a dedicated `hfgcs` account under `/opt/hfgcs/`, directories group
`admin` so a human can manage files without sudo.

| Unit | Role |
|---|---|
| `hfgcs-recorder` | The recorder. Three interlocks in `bin/preflight.sh` |
| `hfgcs-monitor` | Web UI on 127.0.0.1:8898, proxied by nginx with basic auth |
| `hfgcs-retention.timer` | Daily prune of `data/events` by age and total size |

### The three start interlocks

`preflight.sh` runs as `ExecStartPre` and refuses to start unless:

1. `config/ENABLED` exists -- installing is not authorising
2. `kiwi-survey-collector` is not active -- both draw from the same Kiwi pool
3. The newest survey run carries its `COMPLETE` sentinel

Gates 2 and 3 exist because a slot we hold is a slot the survey sees as
unavailable, feeding its documented selection bias from the inside where its
cohort fingerprint cannot detect it.

---

## Protocol facts, verified on live receivers

Each of these cost time to find. They are not guesses.

- **The session id in the URL path must be a plain integer.** Anything else and
  the receiver completes the WebSocket upgrade then silently ignores the
  connection -- no error, no close, no bytes. Measured on two hosts: numeric ->
  16 protocol messages, `<ts>-<rand>` -> 0.
- **A W/F socket MUST send `SET zoom=/start=`.** Without it the receiver tears
  down the whole session, audio included: measured at 20.3 s with zero waterfall
  frames, against 90 s and still streaming once the command was sent.

  **Correction to an earlier note in this file:** it previously claimed that
  neither this client nor Kiwi-SNR-Surveyor's sends that command, and warned that
  the survey's captures may have been silently truncated. That was wrong. The
  survey sends it (`kiwi-client.js:341`) and was never affected. The teardown was
  entirely our own bug.
- **SND frames are a 10-byte header then big-endian int16.**
- **AGC decay must be >= 1000 ms.** See the calibration doc.
- `ip_limit` / `too_busy` in a MSG frame means abandon immediately.

---

## Design decisions worth not reversing by accident

**Rotation is make-before-break.** The next receiver is opened and confirmed
streaming before the old one is dropped. The brief two-slot overlap is across
different receivers, so no sysop sees us holding two.

**Captures stream to disk from the moment of trigger.** The ring buffer holds
pre-roll only. An earlier version extracted finished events from the ring, which
silently capped event length at ring capacity -- a 600 s event lost its first
540 seconds.

**Everything session-scoped lives on a session context.** During a rotation two
sessions are briefly alive; an earlier version hung ring/detector/capture on the
worker and the incoming session could adopt the outgoing one's half-written file.

**Every path that abandons a connection attempt must re-arm the rotation
timer.** `_retryLater()` deliberately does nothing while a session is current,
so a failed ROTATION -- as opposed to a failed initial connect -- would silently
disable rotation for that channel. Observed live: a rotation target hit
`ready_timeout` and the worker then held one receiver for 124 minutes against a
22 minute cap. There are four such paths (failed target, probe exhaustion,
session construction, `open()` throwing) and all four are guarded.

**Connect failures expire after 30 minutes.** One-strike retirement with no decay
drained the whole pool: every eligible receiver failing once took the eligible
count to zero, `bestPropagation` returned 0, and the propagation gate mistook an
exhausted pool for a closed band and parked every channel indefinitely.

**The gate distinguishes "band closed" from "no eligible receivers."** They are
different problems with different remedies and both return a score of zero.

---

## Known holes

1. **The UDXF schedule is transcribed but not USED by site selection.**
   `scheduler/stations.json` now holds all 13 ground stations with coordinates
   and the summer per-frequency table, and the public map uses it. Site selection
   still does not compute a path midpoint from it. The WINTER table is not
   transcribed.
2. **Region preference is advisory, not decisive.** Weight 0.35. It moved
   selection from 26% to 100% North America in a synthetic pool, but live it
   lost a channel to a New Zealand receiver with a better instantaneous path.
3. **The cohort has a region literally named `Other`.** Not in the validation
   list, so those receivers are unreachable whenever any preference is set.
4. ~~Retention does not prune `data/trash`.~~ **RESOLVED 2026-08-08.** The
   holding folder is gone and deletion is permanent. It was never reachable from
   the page, retention never pruned it, and it had reached 521 files / 481 MB.
   `delete-log.jsonl` still records what was removed and by whom.
5. **No direct contact route is published.** By design: a scrapeable address in
   a public repo attracts spam, and a sysop who does not want to participate can
   simply block. Identification is still sent both ways -- `ident_user` in the
   receiver's user list, and an HTTP `User-Agent` linking to this repository,
   which has an Issues tab if someone does want to reach the maintainer.
6. **Live harmonicity reads 0.000 in `/api/status`.** Wired into the per-hop
   callback and the per-event feature vector, but not into `metrics()`.
   Cosmetic -- recorded features are correct.
7. **The monitor can write `data/`.** The one-writer rule (recorder owns
   `events.jsonl`) is enforced by code, not by the filesystem, since the
   settings/label/delete features needed write access.
8. **Transmissions fragment across multiple captures.** A speech pause longer
   than the 3 s hangover closes the event; the next burst starts a new one. One
   94 s transmission was recorded as three files with 6 s and 17 s missing.
   Grouping on display would fix counts and labelling without touching the
   audio.
9. **Simulcast correlation is designed but not built.** HFGCS transmits the
    same message on several frequencies at once. Grouping them is both dedup
    and a free confidence check: a real event appears on 3+ channels, a false
    positive on one.
10. **Waterfall row rate varies by receiver** -- 2.25 to 3.8 rows/s at
    `wf_speed=2`, not the 4.88 measured on one host. A 15 s capture yields ~35
    rows against a 144-row image. The renderer sizes to the rows available
    rather than stretching, which is honest but makes thumbnails uneven.
11. **One capture fell back to audio on a healthy session** (225 s, 2026-08-04
    13:06) with no obvious cause. Not reproduced since.
12. **Waterfall span is a guess.** `wf.viewHalfWidthHz` is 12 kHz, chosen before
    there was anything to look at. Never compared against 6 or 25 kHz on real
    signals.

---

## Open work, in priority order

1. ~~Listen to the two `moxley.us` captures.~~ **MOOT** -- deleted 2026-08-08.
   Rebuilding a labelled set means fresh captures transcribed by ear.
2. Use `scheduler/stations.json` in site selection: path midpoint per frequency
   per hour, rather than solar geometry alone. Transcribe the winter table.
3. Retention for `data/trash` -- age and size cap, same as events.
4. Group fragmented captures into single transmissions for display.
5. Build simulcast correlation on top of that grouping.
6. Remove or demote the modulation test once voicing has more evidence.
7. Wire `lastHarmonicity` into `metrics()`.
8. Coverage reporting on the page -- written to `coverage.jsonl` hourly, nothing
   displays it.

---

## Operational lessons worth not relearning

- **Synthetic negatives are worthless for HF.** Every threshold fitted against
  generated noise failed on contact with a real receiver. Nine minutes of real
  audio taught more than every synthetic test written.
- **A test on a dead host is not a null result, it is no result.** The
  session-id bug was diagnosed correctly, dismissed because the comparison ran
  against a receiver that happened to be down, and then cost an hour of chasing
  firewalls.
- **Do not label by receiver name.** A receiver is not a signal. Captures were
  twice grouped by the station that received them rather than what was in them.
- **Medians hide short events.** A whole-file median averaged two seconds of
  speech into fifteen seconds of static and called it noise.
- **`\n` inside a JS template literal becomes a real newline**, breaking the
  string and killing the entire inline script. `node --check` never sees inside
  the literal. Same for `\.` becoming `/./g`, which parses fine and silently
  matches every character. Four tests guard this class.
- **Do not wrap parse and handler in one try/catch.** An `EROFS` from a blocked
  filesystem write surfaced as "bad JSON" and pointed the diagnosis at the
  request instead of the systemd sandbox.
- **Test under production's constraints.** Config tests passed against a temp
  directory with no sandbox while production was blocked by `ProtectSystem`.
- **Transfer by heredoc or in-place patch, never hand-copied base64.**
- **`pick()` draws randomly from the top N.** Tests that assume an ordering are
  flaky. Test the invariant, not the draw.
- **A safety net nobody can reach is not a safety net.** Soft-delete moved
  captures to `data/trash/`, which no page could read, no route served and
  retention never pruned. It grew to 481 MB while the confirmation dialog kept
  promising the files were recoverable. Either wire the recovery path or delete
  outright; the half-measure cost disk and told users something untrue.
- **Never read values back out of a rendered image.** Decoding the jet palette
  to check a spectrogram produced FOUR wrong conclusions in one session: deep
  blue `(0,0,128)` read as maximum brightness twice, cyan reported as red, and a
  phantom 30% frequency error caused by the red channel falling from 255 to 128
  at the top of the ramp. Compute the cell values with the same arithmetic the
  renderer uses.
- **Auto-scaling contrast lies about empty data.** Scaling to the range present
  is right when a signal exists and wrong when one does not: an empty channel has
  only ~10 dB of receiver noise variation, and stretching that across the ramp
  paints a full-frame rainbow that reads as activity. Hold a minimum span open.
- **Hand-maintained passthrough lists silently drop settings.** This bit twice:
  `buildConfig` swallowed three detector settings, and the session options would
  have swallowed `openWaterfall`. Both now forward everything with a generic
  test. Treat any explicit key list between config and consumer as a defect
  waiting to happen.
- **A change that appears to do nothing may have worked.** Twice a deployed fix
  looked inert: once because a config whitelist dropped it, once because the
  browser was serving a cached thumbnail. Check delivery before re-debugging the
  logic.
- **Validate every anchor BEFORE writing anything.** A multi-part in-place patch
  that asserts per-edit will abort halfway and leave the file inconsistent.
  Check all anchors first, then apply; otherwise a restore from backup is the
  only safe recovery.
- **A still-working component can be a broken one.** The stalled rotation looked
  healthy because audio kept flowing. The only visible symptom was a held time
  that should have been impossible.
