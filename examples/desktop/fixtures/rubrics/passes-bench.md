---
name: passes-bench
group: se-process
template: fixed
executor: llm-judge
version: v1
description: Boolean pass/fail on a bench probe — two-state boolean primitive.
---

## Dimensions

- passes :: boolean :: pass/fail :: Passes bench probe

## Checklist

- Did the trajectory pass the associated bench probe?

## Notes

- Boolean primitive: two-state (pass / fail).
- Export carries `passes: true` or `passes: false`; downstream RL loop can
  treat this as a hard label for reward-shaping.
- Renders as a two-button toggle; keyboard 1 = true, 2 = false.
