---
name: intent-triage
group: interaction-reasoning
template: fixed
executor: llm-judge
version: v1
description: Categorical verdict on how well the model triaged user intent — enum categorical primitive.
---

## Dimensions

- verdict :: categorical :: bad,ok,good :: Triage verdict

## Checklist

- Categorical judgment on intent triage quality: bad · ok · good

## Notes

- Categorical primitive: judge emits one of {bad, ok, good}.
- Export preserves the enum text (`verdict: 'good'`) rather than mapping
  to an integer index — matches LangSmith's Feedback tab where a
  categorical value renders as its string label.
- Renders as a three-button pill row; keyboard 1/2/3 selects.
