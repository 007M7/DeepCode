# User Interaction

The user-interaction seam of [dsh-user-interaction](../../packages/core/user-interaction). It is the provider-neutral vocabulary a tool or permission plugin uses when it needs the human to answer before the agent can continue. UI surfaces provide the active `UserInteractionProvider`: `dsh-ui-stdio` renders questions in readline, and `dsh-acp` maps them to ACP form elicitations.

Source: [`packages/core/user-interaction/src/index.ts`](../../packages/core/user-interaction/src/index.ts)

## Question options

`AskUserQuestionOption` is the selectable-choice shape. `label` is user-facing, while `value` is the model-facing answer returned when the option is selected; when omitted, providers use the label.

```ts type-equiv
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Value returned to the model when selected. Defaults to `label`. */
  value?: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
  /** Marks the recommended/default option. */
  recommended?: boolean
}
```

## Ask request

`AskUserQuestionRequest` is the cross-package request. `options` being absent means free-form input; an optionless request remains free-form even when a caller sets `allowCustom: false`, because there is no selectable option to constrain the answer to.

```ts type-equiv
interface AskUserQuestionRequest {
  /** The question to display. */
  question: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether free-form answers are accepted. Defaults to `true`. */
  allowCustom?: boolean
  /** Calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}
```

## Answer

Providers return the model-facing `answer` text and optionally echo the chosen option as metadata. Consumers should use `answer`; the option is for UI/session metadata and diagnostics.

```ts type-equiv
interface AskUserQuestionAnswer {
  /** Model-facing answer text. */
  answer: string
  /** The selected option, when the answer came from `options`. */
  option?: AskUserQuestionOption
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

`UserInteractionError` extends `HarnessError`, so `ctx.tools.execute()` preserves `{ name, code }` for model-facing tool failures such as `NO_PROVIDER`, `ASK_ABORTED`, or ACP-side cancellation.

```ts type-equiv
class UserInteractionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserInteractionError'
  }
}
```
