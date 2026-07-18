---
name: code-review
group: se-process
template: code-review
executor: llm-judge
version: v1
description: Reviewer rubric — evaluates a code-review trajectory on style, correctness, and test coverage.
---

## Checklist

- Identifies incorrect behavior (bugs, edge cases) present in the diff
- Style feedback is specific to project conventions, not generic
- Suggests test coverage where the diff adds untested code paths
- Prioritizes correctness over style when both are present
- Tone is direct without being hostile; asks questions when uncertain

## Notes

- LLM-as-judge for now; the code-executor variant would run project
  linters and compare their output against the review comments.
- Deduct when reviewer misses a real bug the diff introduces.
- Deduct when reviewer flags a style-only issue as correctness-critical.
