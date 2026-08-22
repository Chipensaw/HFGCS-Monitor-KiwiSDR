#!/usr/bin/env python3
"""Report where the live config differs from the tracked example.

The live config (config/hfgcs.json) is gitignored on purpose: it carries
kiwiIdentUser, which is an on-air identity and must not ship to anyone who
clones this repo. The cost of that is real -- a tuning decision made on the
box has no version history at all. This closes most of the gap by naming the
fields that are ALLOWED to differ per installer and reporting everything else.

Anything listed here is a decision living only on one machine. Promote it to
config/hfgcs.example.json and commit it, or revert it.

Exit status is always 0. Drift is worth knowing about, not worth refusing to
record over.
"""
import json
import sys

# Expected to differ per installer. Everything else should match the example.
ALLOWED = {
    'identification.kiwiIdentUser',
    'frequencies[].active',
}


def flat(node, path='', out=None):
    """Flatten to dotted paths. Keys starting with _ are notes, not config."""
    if out is None:
        out = {}
    if isinstance(node, dict):
        for key, val in node.items():
            if key.startswith('_'):
                continue
            flat(val, (path + '.' + key) if path else key, out)
    elif isinstance(node, list):
        # List elements collapse onto one path, so frequencies[].active is a
        # single comparison of two ordered lists rather than six separate ones.
        for val in node:
            flat(val, path + '[]', out)
    else:
        out.setdefault(path, []).append(node)
    return out


def main(argv):
    if len(argv) != 3:
        print('usage: config-drift.py <live.json> <example.json>')
        return 0
    try:
        live = flat(json.load(open(argv[1])))
        example = flat(json.load(open(argv[2])))
    except Exception as exc:
        print('[drift] skipped: %s' % exc)
        return 0

    drift = [k for k in sorted(set(live) | set(example))
             if k not in ALLOWED and live.get(k) != example.get(k)]

    if not drift:
        print('[drift] live config matches the example on every tracked field.')
        return 0

    print('[drift] live config differs from the tracked example in %d field(s):'
          % len(drift))
    for key in drift:
        print('[drift]   %s: live=%r example=%r'
              % (key, live.get(key), example.get(key)))
    print('[drift] These exist only on this box. Promote them to')
    print('[drift] config/hfgcs.example.json and commit, or revert them.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
