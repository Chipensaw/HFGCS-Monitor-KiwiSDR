# Detector calibration

What was measured, what it establishes, and what it does not.

## The dataset

| | n | source |
|---|---|---|
| Confirmed voice | 3 | listened to by ear, all 11175 kHz, one evening |
| Confirmed not-voice | 69 | listened to / all-static run |
| Unlabelled, never heard | 2 | highest-scoring non-voice; see below |
| Reference EAM | 1 | 146 s USAF EAM, 8992 kHz, 27 Jun 2016 |

That is three positives. It is enough to show a separation exists. It is not
enough to call a threshold calibrated.

## Feature performance

Measured with `analyseBuffer()` over whole captures.

| feature | confirmed voice | confirmed static | separates? |
|---|---|---|---|
| **harmonicVoicedFraction** | 3.14% / 35.6% / 38.3% | median 0.00%, p95 0.22%, max 10.4% | **yes** |
| harmonicityP90 | 0.302 / 0.811 / 0.836 | 0.24 - 0.27 | yes, except the weak one |
| flatDipFraction | 0.011 / 0.411 / 0.429 | 0.000 - 0.005 | yes, except the weak one |
| medianModFraction | 0.712 (EAM) | 0.367 - 0.703 | **NO** |

### The modulation feature does not work

`medianModFraction` (0.2-3 Hz envelope modulation) measured a 5-6x separation
against **synthetic white noise** and none at all against real HF. Real static
reaches 0.703; a real EAM is 0.712.

White noise has no fading, no atmospheric bursts and no AGC pumping. Those are
exactly what generate low-frequency envelope modulation on a real receiver. The
negative class was fiction, and it was the class that mattered.

It remains in the trigger path because it is harmless once voicing carries the
decision. It should be removed or demoted once voicing has more evidence.

### Why voicing wins

Speech is periodic in the 70-300 Hz pitch range. Static is not. That holds even
when the signal is weak: the weakest confirmed voice (`km3t`, audible but fading
after ~5 s) still scored 3.14% against a static p95 of 0.22%.

Threshold is 3%, applied over a rolling ~5.5 s window rather than a whole-file
average. A whole-file median once averaged two seconds of real speech into
fifteen seconds of static and reported it as noise.

## Replay result

All 72 labelled captures through the current detector:

```
voice kept       3/3     (including the weak, fading one)
static rejected 68/69
captures written 72 -> 4
```

The single false positive is a structured non-voice signal -- probably a data
burst -- which scores 10.4% voiced. There is no threshold that keeps the weak
voice at 3.14% and also rejects it. Separating marginal speech from data modes
needs a feature this project does not yet have.

## The AGC constraint

The receiver's AGC decay directly attacks the detector.

| AGC decay | modulation feature |
|---|---|
| none | 73.7% |
| 2000 ms | 74.5% |
| 500 ms | 63.0% |
| **100 ms** | **18.8%** |

A 0.1 s AGC is a ~1.6 Hz corner on the audio envelope, notching the exact band
the detector used to live in. `kiwi-audio-client.js` throws on any value below
1000 ms rather than accepting a setting that silently degrades detection.

## What this does NOT establish

- **Any false-positive rate.** 69 negatives from two evenings in one region.
- **Behaviour on other bands or distances.** All three positives are 11175 kHz,
  received in North America.
- **The floor for weak signals.** One capture sits at 3.48% voiced -- 1.16x over
  threshold. The margin near the floor is a single data point.
- **Data-mode rejection.** Known to fail on at least one structured non-voice
  signal.

## The mains-hum false positive

A receiver with heavy powerline noise produced 11 false captures in one night.
Every hop it scored as "voiced" sat at exactly 120.0 Hz -- the second harmonic
of 60 Hz mains -- which autocorrelation cannot distinguish from a voice by
strength alone.

The discriminator is **stability, not frequency**. Human pitch wanders: measured
across the reference EAM, relative spread (p90-p10)/p50 was 0.842. Mains hum is
locked to the grid: 0.020, a 40x difference. A hop is rejected only when its
pitch is BOTH on a 50/60 Hz harmonic AND unnaturally steady, so a voice passing
through 120 Hz still counts.

Replayed against the 11 real captures: 10.7-17.8% voiced fell to 0.9-1.7%, well
below the trigger. The reference EAM moved 27.36% -> 27.35%, and only 2 hops of
6842 were rejected. The filter is surgical.

One caution recorded here because it cost time: a synthetic pure sine is NOT a
good stand-in for real mains noise. It is too clean for the pitch tracker to lock
onto consistently and scores higher than the real thing. The unit test asserts
only that the mechanism engages; the real verification is the replay.

## Two captures nobody has listened to

The highest-scoring non-voice files in the set, both kept by the current gate:

```
20260731T010930Z_8992_kiwisdr.moxley.us_8073.wav   voiced 12.15%
20260731T010809Z_8992_kiwisdr.moxley.us_8073.wav   voiced  9.74%
```

If they are voice, the false-positive count drops to one in 71 and the
threshold is on much firmer ground. Cheapest available improvement to the
calibration.
