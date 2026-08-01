# Etiquette

This tool holds a slot on receivers that volunteers pay for, host and maintain.
It is a heavier neighbour than a periodic crawler: it stays connected. The
limits below live in code, not in command-line flags, and they ship
conservative.

One person running this politely is a rounding error. Fifty people running it
without limits is a distributed denial of service against hobbyists.

## What the recorder does

| Behaviour | Why |
|---|---|
| ONE slot per frequency, one frequency per receiver | Never two connections to the same sysop |
| Session capped ~22 min, then release and re-select | Under the common 30-min inactivity limit, so we leave before being kicked |
| Rotation jitter, and a recent-use penalty per receiver | Spreads load; no sysop sees us often |
| Make-before-break rotation | The brief two-slot overlap is across DIFFERENT receivers |
| `usersMax >= 4` filter | Taking 1 of 2 slots is half a volunteer's capacity |
| Proxied endpoints excluded by default | `proxy.kiwisdr.com` bandwidth is donated to the community |
| Waterfall socket NOT opened | Halves what we ask of the receiver, and avoids a teardown bug |
| TCP probe before the WebSocket handshake | A dead host costs ~2.5 s, not a full connect timeout |
| One connect failure retires a receiver for 30 min | No reconnect hammering |
| `ip_limit` / `too_busy` abandons immediately, no retry | A refusal is an answer |
| Propagation gate RELEASES the slot when the band is closed | Holding 4724 kHz through local noon consumes a receiver to hear a dead band |
| `config/blocklist.txt` honoured always | Exclusions are honoured unconditionally, no flag required |
| `ident_user` sent on every session | Shows in the receiver's user list |
| HTTP `User-Agent` sent on every connection | The other place a sysop looks. Names the tool and links to this repo |
| `config/ENABLED` must be created by hand at a shell | Installing the software is not the same act as authorising it to contact anyone |

## Set your identity

`config/hfgcs.json` -> `identification.kiwiIdentUser`. It is sent as
`SET ident_user=` and `SERVER DE CLIENT <id> SND`, and it is what a sysop sees.
Use something traceable back to you. The default placeholder is deliberately
not usable.

## If you are a sysop

Every connection identifies itself, in the receiver's user list and in the
HTTP `User-Agent`, and the `User-Agent` links to this repository. If you would
rather not be included, blocking is entirely reasonable and needs no
explanation.

Operators running this tool maintain their own exclusion list:

```
config/blocklist.txt

example.ddns.net:8073      exclude one receiver
example.ddns.net           exclude every port on that host
```

## What identifies a connection

Two places, both populated:

| Where | Value |
|---|---|
| Receiver's user list | your `identification.kiwiIdentUser` |
| HTTP `User-Agent` on the upgrade | `HFGCS-Monitor-KiwiSDR/0.1 (+https://github.com/Chipensaw/HFGCS-Monitor-KiwiSDR)` |

The User-Agent was previously configured but never actually sent, so
connections carried the Node default and a sysop had no way to identify them.
That is fixed. It is recorded here because a document claiming a tool is
considerate, while quietly omitting where it was not, is worth less than no
document.
