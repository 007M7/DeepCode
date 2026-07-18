#!/usr/bin/env python3
# dedup_exact.py — exact-match dedup over a JSONL stream of chat messages.
#
# Contract (see docs/design-refs/rl-workflow-needs.md §3):
#   argv[1] = input JSONL path (one row per turn)
#   argv[2] = output JSONL path (dedup'd)
# The last line of stdout is a JSON summary `{written, dropped, notes}` so the
# Hub can render the diff chip without inspecting the output file directly.
#
# The dedup key is the SHA1 of the row's `messages` list (or the whole row if
# `messages` is absent). Rows that fail to parse are dropped and counted.
# This is a demo script — a researcher would fork it, swap the key function,
# and save the new version.

import hashlib
import json
import sys


def key_of(row):
    if isinstance(row, dict) and "messages" in row:
        return hashlib.sha1(
            json.dumps(row["messages"], sort_keys=True).encode("utf-8")
        ).hexdigest()
    return hashlib.sha1(json.dumps(row, sort_keys=True).encode("utf-8")).hexdigest()


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"written": 0, "dropped": 0, "notes": "usage: dedup_exact.py in.jsonl out.jsonl"}))
        sys.exit(2)
    input_path = sys.argv[1]
    output_path = sys.argv[2]

    seen = set()
    written = 0
    dropped_dup = 0
    dropped_bad = 0

    with open(input_path, "r", encoding="utf-8") as fin, \
            open(output_path, "w", encoding="utf-8") as fout:
        for i, raw in enumerate(fin):
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                dropped_bad += 1
                continue
            k = key_of(row)
            if k in seen:
                dropped_dup += 1
                continue
            seen.add(k)
            fout.write(json.dumps(row, ensure_ascii=False) + "\n")
            written += 1
            if (i + 1) % 1000 == 0:
                print(f"processed {i + 1} rows, kept {written}, dedup dropped {dropped_dup}")

    total_dropped = dropped_dup + dropped_bad
    notes_bits = []
    if dropped_dup:
        notes_bits.append(f"{dropped_dup} exact duplicates")
    if dropped_bad:
        notes_bits.append(f"{dropped_bad} malformed rows")
    notes = "; ".join(notes_bits) if notes_bits else "no duplicates found"
    print(json.dumps({"written": written, "dropped": total_dropped, "notes": notes}))


if __name__ == "__main__":
    main()
