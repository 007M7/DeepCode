---
name: correctness-score
group: fix-optimize
template: fixed
executor: llm-judge
version: v1
description: Continuous 0-1 correctness score — real-valued continuous primitive.
---

## Dimensions

- correctness :: continuous :: 0-1 :: Correctness

## Checklist

- Overall correctness on the trajectory's stated goal (0 = wrong, 1 = correct)

## Notes

- Continuous primitive: judge model emits a real number in [0, 1].
- Export carries `dim_types.correctness = { type: 'continuous', min: 0, max: 1 }`
  so downstream consumers can treat this as a probability rather than a
  discrete class.
- Small integer ranges (like 1-5) render as button rows; the 0-1 range
  renders as a numeric input for a real-valued score.
