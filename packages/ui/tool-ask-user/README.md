# @deepseek-ai/dsh-tool-ask-user

Model-facing `ask_user_question` tool over `ctx.userInteraction`. It lets the model ask the human a concise question when it needs confirmation, a choice, or missing information before continuing.

## Tool

`ask_user_question` accepts:

- `questions` — required non-empty array of question objects.
- `id` — required stable id on each question, echoed in the answer.
- `question` — required question text for each question.
- `header` — optional short heading.
- `options` — optional choices with `label` and `description`. If recommending a choice, put it first and append `(Recommended)` to that label.
- `multi_select` — whether that question may return more than one selected option.

The tool calls `ctx.userInteraction.ask()` and returns JSON text shaped as `{ "answers": [{ "id": "...", "selected": ["..."], "custom": "..." }] }`. `selected` contains option labels; `custom` is present only for a free-form answer and overrides selected choices.

## Role

This is the consumer package for the user-interaction seam. It does not render UI and does not know how input is collected; it only translates model arguments into `AskUserQuestionRequest` and returns the human answer to the agent loop.
