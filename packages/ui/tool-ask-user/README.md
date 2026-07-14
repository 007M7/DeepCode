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

## Model Experience

### Tool schema

**What the model sees**: The model sees the generated [`ask_user_question` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user), including question ids, prompts, headings, options, and multi-select flags.

**Token effect**: Fixed schema cost on every request where the tool is visible.

### Tool-call history and result

**What the model sees**: The model's full questions remain in the assistant tool-call arguments. After the human answers, the next step sees compact JSON in the exact shape `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}`; `custom` is omitted when unused and `selected` can contain zero, one, or several labels. UI interaction while the call is pending is not model context.

**Token effect**: Arguments and answer JSON are data-dependent retained tokens; there is no token cost while waiting for the human.

## Known Limitations and Deferred Work

- **A pending question blocks the tool call until the human answers** — the tool declares no `timeout-policy` budget; cancellation rides the turn's `exec.signal` only.
- **Answers return as JSON text** — the seam's structured `AskUserQuestionAnswer` is serialized into the tool result rather than carried as typed content blocks.
