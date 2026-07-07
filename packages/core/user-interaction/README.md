# @deepseek-ai/dsh-user-interaction

Abstract user-interaction seam. It owns `ctx.userInteraction`, the service a model-facing tool or permission plugin uses when it needs to pause work and ask the human for a decision.

## Service: `UserInteractionService` (ctx key: `userInteraction`)

### Public API

- `ctx.userInteraction.registerProvider(provider): () => void` Register the UI-side provider. Only one provider may be active in a context; disposal unregisters it.
- `ctx.userInteraction.ask(request): Promise<AskUserQuestionAnswer>` Ask the active provider and wait for the answer.

### Key Types

- `AskUserQuestionRequest` — `{ questions: [{ id, question, header?, options?, multiSelect? }], agent?, signal? }`.
- `AskUserQuestionOption` — `{ label, description? }`.
- `AskUserQuestionAnswer` — `{ answers: [{ id, selected, custom? }] }`.
- `UserInteractionProvider` — UI implementation with `ask(request)`.
- `UserInteractionError` — `HarnessError` subclass with codes such as `EMPTY_QUESTIONS`, `NO_PROVIDER`, `DUPLICATE_PROVIDER`, and `ASK_ABORTED`.

When an answer includes `custom`, `selected` is empty; custom text is an override rather than a supplement to selected choices.

## Role

This is the interface package. Model-facing consumers such as `@deepseek-ai/dsh-tool-ask-user` depend on this seam; UI front doors such as the `stdio-agent` readline module and the `acp` bridge provide the provider. The loop stays unchanged: a tool call simply awaits a promise, and the tool result resumes the normal agent loop.
