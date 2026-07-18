---
name: svg-generation
group: interaction-reasoning
template: per-prompt
executor: llm-judge
version: v1
description: Per-prompt rubric — judge model composes SVG-specific criteria before scoring, comparing to a reference image described in the prompt.
---

## Checklist

- The generated SVG renders without XML errors
- Shape count and composition match the prompt intent
- Colors and gradient use match the reference (or spec)
- Text elements (if any) match the requested strings
- Prompt-specific criteria (added by the judge model per task)

## Notes

- Per-prompt template: the judge model receives the prompt + reference image
  description, then extends the fixed checklist with 2–4 prompt-specific
  items before scoring. Output preserves the {resolved, score, reason}
  block for DSBench compatibility.
- Deduct heavily when the SVG is a stub (empty viewBox, no shapes).
