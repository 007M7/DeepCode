---
name: multi-turn-feedback
group: interaction-reasoning
template: multi-turn
executor: llm-judge
version: v1
description: Score each assistant turn against the 5 fixed multi-turn dimensions; each dim 1-5 relative to the immediately preceding user feedback.
---

## Checklist

- Feedback understanding — the model correctly parsed the user's ask
- Fix effectiveness — the response actually addressed the previous feedback
- No regression — behavior that was already good stayed good
- Over-correction — the model changed only what the feedback asked for
- Convergence — the turn is moving toward a stable answer

## Notes

- One score per dimension per assistant turn, on a 1–5 scale.
- The pinned prior-user feedback is the anchor: every dim scores this turn
  relative to that specific prior message, not the whole trajectory.
- Stage-2 of the RL plan uses this rubric alongside the stage-1 task rubric
  — this one grades feedback response quality, the other grades base
  task quality.
