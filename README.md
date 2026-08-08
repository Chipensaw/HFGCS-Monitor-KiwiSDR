# HFGCS-Monitor-KiwiSDR

Unattended recorder for **HFGCS** voice transmissions, using publicly listed
**KiwiSDR** receivers as its front end. It watches one or more HFGCS
frequencies, detects speech, records it with pre-roll, and publishes the
captures to a password-protected web page for listening and labelling.

It has no radio of its own. It borrows other people's.
**Read [ETIQUETTE.md](ETIQUETTE.md) before running it.**

## Read this first

The detector's thresholds are **provisional**. They rest on 3 confirmed-voice
and 69 confirmed-not-voice captures from one region across two evenings. The
separation is clean and the physics is sound, but that is not a calibration
set. See [docs/detector-calibration.md](docs/detector-calibration.md) for what
was measured and what it does not yet establish.

## How it decides something is voice

Two gates, in this order:

1. **Spectral flatness** rejects carriers and birdies outright.
2. **Voicing** -- autocorrelation in the 70-300 Hz pitch range. A hop counts as
   voiced above 0.40; at least 3% of a rolling ~5.5 s window must be voiced.

Real static has **no periodic voicing**. Across 69 confirmed not-voice captures
the voiced fraction has a median of 0.00% and p95 of 0.22%. Three confirmed
voice captures sit at 3.14%, 35.6% and 38.3%.

There is a third test in the code -- 0.2-3 Hz envelope modulation -- which
**does not work on real HF** and is retained only because it is harmless.
Measured static reaches 0.703 against a real EAM's 0.712. It was fitted against
synthetic white noise, which has none of the fading, atmospheric bursts or AGC
pumping that generate low-frequency envelope modulation on a real receiver.
That mistake is documented rather than quietly removed, because it is the most
instructive thing in the repo.

## Architecture

Full detail in **[docs/system-architecture.md](docs/system-architecture.md)** --
the three-process topology, config contract, session model and data ownership.
Sketch below.

```
scheduler/select.js    pick a receiver: filter (etiquette) then rank
        |              (slots>=4, non-proxied, band coverage, not blocklisted,
        v               solar geometry, survey quality, region preference)
recorder/kiwi-audio-client.js   SND socket: 12 kHz PCM
        |                       W/F socket: ~29 kHz of RF spectrum
        |
recorder/ring-buffer.js         60 s ring, PRE-ROLL ONLY
        |
detector/features.js -> voice-detector.js
        |
recorder/encoder.js             streams to WAV from the moment of trigger
        |
recorder/spectrogram.js         waterfall thumbnail, RF preferred
        |
data/events/<day>/              clip + png + events.jsonl with feature vector
        |
monitor/server.js               operator page (auth): labelling, delete, settings
monitor/public.js               public page: captures, audio, map
```

One Node process, one worker per active frequency. Receivers rotate underneath
a worker; the worker owns the frequency.

## Waterfall thumbnails

Every capture gets a spectrogram beside it, because speech, data bursts and
carriers look completely different in a waterfall and nearly identical in a
table of numbers.

Where the receiver's waterfall socket is available, these show **real RF
spectrum, about 29 kHz wide**, so a 3 kHz transmission appears as a narrow band
in context -- and it becomes obvious when a detection is actually a strong
neighbour bleeding into the passband. Otherwise the thumbnail falls back to an
audio spectrogram, which can never exceed 6 kHz. Each record notes which was
used in `thumbSource`.

The waterfall costs a second socket and about 5 KB/s of a volunteer's
bandwidth. See [ETIQUETTE.md](ETIQUETTE.md), and set
`receiver.openWaterfall: false` to turn it off.

## Install

Requires Node 20+ and `ws`. Nothing else.

```bash
git clone git@github.com:Chipensaw/HFGCS-Monitor-KiwiSDR.git
cd HFGCS-Monitor-KiwiSDR
npm install --omit=dev

cp config/hfgcs.example.json config/hfgcs.json
# EDIT identification.kiwiIdentUser -- the placeholder is not usable
```

You also need a receiver pool. This project consumes the `cohort.json`
produced by [Kiwi-SNR-Surveyor](https://github.com/Chipensaw/Kiwi-SNR-Surveyor),
and optionally its `scores.json` to rank receivers by measured noise quality.

`systemd/` holds the unit files. `bin/preflight.sh` refuses to start unless
`config/ENABLED` exists -- installing is not authorising.

## Operating it

```bash
sudo -u hfgcs touch config/ENABLED     # authorise
sudo systemctl start hfgcs-recorder
sudo journalctl -u hfgcs-recorder -f
```

Frequencies, thresholds, region preference, identity and retention are all
editable on the web page. **Changes take effect on the next recorder start.**

Enable/disable is deliberately NOT on the page. It is the authorisation to
contact other people's receivers and stays a shell act.

## Public view

`monitor/public.js` serves a read-only page: captures, audio, thumbnails, and a
world map showing receiver positions, the 13 HFGCS ground stations, which are
scheduled on air at the current hour, and the great-circle paths between them.

The map is Leaflet on CartoDB's dark OSM tiles, the same basemap the WSPR and
HFDL maps use, with a live grayline. Ground stations are gold when scheduled on
air at the current hour and grey when not.

It is a separate process from the operator interface, not the same page with
controls hidden. The operator monitor holds a sudo grant; exposing any part of it
publicly would put that one routing mistake away from a stranger. The public
process has no sudo, no write paths, and answers only GET and HEAD. Receiver
endpoints are never published and coordinates are rounded to about 11 km.

## Status

Working and running. Not finished. See [HANDOFF.md](HANDOFF.md) for the open-work
list, and [docs/detector-calibration.md](docs/detector-calibration.md) for what
the detector thresholds do and do not rest on.
