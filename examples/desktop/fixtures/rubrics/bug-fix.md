---
name: bug-fix
group: fix-optimize
template: fixed
executor: llm-judge
version: v1
description: Evaluate a bug-fix trajectory — reproduction, minimality, tests, regressions, explanation.
---

## Checklist

- Reproduces the reported failure with a minimal case before patching
- Patch is minimal: no unrelated cleanups, formatting, or refactors
- Regression test added or existing test updated to cover the fix
- No obvious regressions in adjacent behavior (spot-check callers)
- Written explanation states the root cause, not just the symptom

## Notes

- Prefer patches that add a regression test in the same PR.
- Deduct when the model conflates symptom (crash) with cause (bad input).
- Deduct when the model rewrites more than the failing branch.
