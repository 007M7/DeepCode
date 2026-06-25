# @deepseek-ai/dsh-user-interaction

Abstract user-interaction seam. It owns `ctx.userInteraction`, the service a model-facing tool or permission plugin uses when it needs to pause work and ask the human for a decision.

## Service: `UserInteractionService` (ctx key: `userInteraction`)

### Public API

- `ctx.userInteraction.registerProvider(provider): () => void` Register the UI-side provider. Only one provider may be active in a context; disposal unregisters it.
- `ctx.userInteraction.ask(request): Promise<AskUserQuestionAnswer>` Ask the active provider and wait for the answer.

### Key Types

- `AskUserQuestionRequest` — `{ question, header?, options?, allowCustom?, agent?, signal? }`.
- `AskUserQuestionOption` — `{ label, value?, description?, recommended? }`.
- `AskUserQuestionAnswer` — `{ answer, option? }`.
- `UserInteractionProvider` — UI implementation with `ask(request)`.
- `UserInteractionError` — `HarnessError` subclass with codes such as `NO_PROVIDER`, `DUPLICATE_PROVIDER`, and `ASK_ABORTED`.

## Role

This is the interface package. Model-facing consumers such as `@deepseek-ai/dsh-tool-ask-user` depend on this seam; UI implementations such as `@deepseek-ai/dsh-ui-stdio` provide the provider. The loop stays unchanged: a tool call simply awaits a promise, and the tool result resumes the normal agent loop.
