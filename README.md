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

```
scheduler/select.js    pick a receiver: filter (etiquette) then rank
        |              (slots>=4, non-proxied, band coverage, not blocklisted,
        v               solar geometry, survey quality, region preference)
recorder/kiwi-audio-client.js   one SND WebSocket per channel, 12 kHz PCM
        |
recorder/ring-buffer.js         60 s ring, PRE-ROLL ONLY
        |
detector/features.js -> voice-detector.js
        |
recorder/encoder.js             streams to WAV from the moment of trigger
        |
data/events/<day>/              clip + events.jsonl with full feature vector
        |
monitor/server.js               page, labelling, delete, settings
```

One Node process, one worker per active frequency. Receivers rotate underneath
a worker; the worker owns the frequency.

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

## Status

Working and running. Not finished. The largest gap is that the **UDXF
ground-station schedule is not transcribed**, so site selection cannot compute
a path midpoint and falls back to solar geometry plus a region preference. See
[HANDOFF.md](HANDOFF.md) for the full open-work list.
