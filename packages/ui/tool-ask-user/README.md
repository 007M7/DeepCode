# @deepseek-ai/dsh-tool-ask-user

Model-facing `ask_user_question` tool over `ctx.userInteraction`. It lets the model ask the human a concise question when it needs confirmation, a choice, or missing information before continuing.

## Tool

`ask_user_question` accepts:

- `question` — required question text.
- `header` — optional short heading.
- `options` — optional choices with `label`, `value`, `description`, and `recommended`.
- `allow_custom` — whether free-form answers are allowed; defaults to the provider's normal `true` behavior.

The tool calls `ctx.userInteraction.ask()` and returns the selected option value or custom answer as a text tool result.

## Role

This is the consumer package for the user-interaction seam. It does not render UI and does not know how input is collected; it only translates model arguments into `AskUserQuestionRequest` and returns the human answer to the agent loop.
