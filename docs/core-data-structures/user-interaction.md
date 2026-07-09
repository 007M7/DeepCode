# User Interaction

The user-interaction seam of [dsh-user-interaction](../../packages/ui/user-interaction). It is the provider-neutral vocabulary a tool or permission plugin uses when it needs the human to answer before the agent can continue. UI surfaces provide the active `UserInteractionProvider`: `dsh-stdio-agent` renders questions in readline, and `dsh-acp` maps them to ACP form elicitations.

Source: [`packages/ui/user-interaction/src/index.ts`](../../packages/ui/user-interaction/src/index.ts)

## Question options

`AskUserQuestionOption` is the selectable-choice shape. `label` is the user-facing option text and also the model-facing selected value; `description` is optional UI help text.

```ts type-equiv
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## Question item

`AskUserQuestionItem` is one question in a request. The model supplies a stable `id`, which is echoed back with the answer so batched questions remain routable.

```ts type-equiv
interface AskUserQuestionItem {
  /** Stable model-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
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

Providers return one answer per answered question id. `selected` contains selected option labels, and `custom` carries a free-form "Other" answer when the user typed one. When `custom` is present, `selected` is empty; custom text is an answer override, not a supplement to selected choices.

```ts type-equiv
interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. Empty when the answer is purely custom text. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}
```

```ts type-equiv
interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}
```

## Provider

Only one provider may be active in a context. Provider registration is effect-bound so HMR/disposal removes the active UI.

```ts type-equiv
interface UserInteractionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}
```

## Errors

`UserInteractionError` extends `HarnessError`, so `ctx.tools.execute()` preserves `{ name, code }` for model-facing tool failures such as `EMPTY_QUESTIONS`, `NO_PROVIDER`, `ASK_ABORTED`, or ACP-side cancellation.

```ts type-equiv
class UserInteractionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserInteractionError'
  }
}
```
