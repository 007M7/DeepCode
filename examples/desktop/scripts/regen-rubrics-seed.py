#!/usr/bin/env python3
# Regenerate src/renderer/rubrics-seed.js from fixtures/rubrics/*.md +
# fixtures/annotation/sample-sessions.json. Run after editing any of those.
#
# Rationale: the renderer runs from file:// with strict CSP, so it cannot
# fetch() the .md and .json files at runtime. Inlining them into a small
# `-seed.js` script keeps the fixtures as the source of truth while giving
# the renderer a synchronous, dependency-free path to them. Same pattern
# as src/renderer/debug-fixtures.js.

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUBRICS_DIR = os.path.join(ROOT, "fixtures", "rubrics")
SAMPLES_PATH = os.path.join(ROOT, "fixtures", "annotation", "sample-sessions.json")
OUT = os.path.join(ROOT, "src", "renderer", "rubrics-seed.js")

RUBRIC_ORDER = [
    "bug-fix.md",
    "svg-generation.md",
    "multi-turn-feedback.md",
    "code-review.md",
    # Typed-primitive fixtures (LangSmith FeedbackSchema parity) — one
    # rubric per primitive so the demo drawer can showcase all three
    # scoring shapes without needing a real evaluator.
    "correctness-score.md",
    "intent-triage.md",
    "passes-bench.md",
]


def main() -> int:
    rubrics = []
    for name in RUBRIC_ORDER:
        path = os.path.join(RUBRICS_DIR, name)
        with open(path, "r", encoding="utf-8") as f:
            rubrics.append(f.read())
    with open(SAMPLES_PATH, "r", encoding="utf-8") as f:
        samples = json.load(f)
    lines = []
    lines.append("// Auto-inlined fixture seeds for the Rubrics + Annotation pages.")
    lines.append("// Renderer runs at file:// so we inline the SKILL.md blobs and sample")
    lines.append("// sessions here instead of relying on fetch(). To refresh:")
    lines.append("//   python3 scripts/regen-rubrics-seed.py")
    lines.append("//")
    lines.append("// The 4 rubrics live at fixtures/rubrics/*.md; the sample sessions live at")
    lines.append("// fixtures/annotation/sample-sessions.json.")
    lines.append("")
    lines.append("'use strict'")
    lines.append("")
    lines.append("const RUBRICS_SEED = " + json.dumps(rubrics, ensure_ascii=False, indent=2))
    lines.append("")
    lines.append("const ANNOTATION_SAMPLES = " + json.dumps(samples, ensure_ascii=False, indent=2))
    lines.append("")
    lines.append("if (typeof window !== 'undefined') {")
    lines.append("  window.__dshRubricsSeed = RUBRICS_SEED")
    lines.append("  window.__dshAnnotationSamples = ANNOTATION_SAMPLES")
    lines.append("}")
    lines.append("if (typeof module !== 'undefined' && module.exports) {")
    lines.append("  module.exports = { RUBRICS_SEED, ANNOTATION_SAMPLES }")
    lines.append("}")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
