# User Interaction

English | [中文](user-interaction.zh.md)

The user-interaction seam of [dsh-user-interaction](../../packages/ui/user-interaction). It is the provider-neutral vocabulary a tool or permission plugin uses when it needs the human to answer before the agent can continue. UI surfaces provide the active `UserInteractionProvider`; `dsh-tui` uses keyboard-driven overlays and the host runtime relays requests to its connected client.

Source: [`packages/ui/user-interaction/src/index.ts`](../../packages/ui/user-interaction/src/index.ts)

## Question options

`AskUserQuestionOption` is the selectable-choice shape. `label` is the user-facing option text and also the model-facing selected value; `description` is optional UI help text.

```ts type-equiv
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## Question item

`AskUserQuestionItem` is one question in a request. The caller supplies a stable `id`, which is echoed back with the answer so batched questions remain routable. Optional `detail` carries supporting text that providers render with the question but keep out of selectable option labels.

```ts type-equiv
/** One question in a user-interaction request. */
interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
}
```

## Ask request

`AskUserQuestionRequest` is the cross-package request. `questions` is an array so a UI can present related prompts in one flow while preserving a stable id per answer.

```ts type-equiv
/** Request for a human answer. */
interface AskUserQuestionRequest {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}
```

## Answer

Providers return one answer item per question id. `selected` contains selected option labels, and `custom` carries a free-form "Other" answer when the user typed one. When `custom` is present, `selected` is empty; custom text is an answer override, not a supplement to selected choices. A UI may also use an item with empty `selected` and no `custom` to preserve a skipped question in an otherwise completed batch.

```ts type-equiv
/** Answer to one question. */
interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. Empty for custom or unanswered choices. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}
```

```ts type-equiv
/** The human's answer. */
interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}
```

## Provider

Only one provider may be active in a context. Provider registration is effect-bound so HMR/disposal removes the active UI.

```ts type-equiv
/** UI-side provider for user questions. */
interface UserInteractionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}
```

## Errors

`UserInteractionError` extends `HarnessError`, so `ctx.tools.execute()` preserves `{ name, code }` for model-facing tool failures such as `EMPTY_QUESTIONS`, `NO_PROVIDER`, `ASK_ABORTED`, or UI-side cancellation.

```ts type-equiv
/** Stable error taxonomy for user-interaction failures. */
class UserInteractionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserInteractionError'
  }
}
```
