# 用户交互

[English](user-interaction.md) | 中文

[dsh-user-interaction](../../packages/ui/user-interaction) 的用户交互 seam。它是工具或权限插件需要人类回答后 agent（智能体）才能继续时所使用的、提供方无关的词汇。UI surface 提供活跃的 `UserInteractionProvider`；`dsh-tui` 使用键盘驱动的 overlay，host 运行时把请求转发给它连接的客户端。

源码：[`packages/ui/user-interaction/src/index.ts`](../../packages/ui/user-interaction/src/index.ts)

## 问题选项

`AskUserQuestionOption` 是可选择项的形状。`label` 是面向用户的选项文字，同时也是面向模型的选中值；`description` 是可选的 UI 帮助文本。

```ts type-equiv
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## 问题条目

`AskUserQuestionItem` 是请求中的一个问题。调用方提供稳定的 `id`，它会随答案原样返回，使批量问题仍可路由。可选的 `detail` 携带辅助文本；提供方会将其随问题渲染，但不会放入可选 option label。

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

## 提问请求

`AskUserQuestionRequest` 是跨包（package）的请求。`questions` 是数组，这样 UI 可以在一个流程中呈现相关提示，同时保持每个回答有稳定的 id。

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

## 回答

提供方为每个问题 id 返回一个回答项。`selected` 包含选中的选项标签，`custom` 在用户输入自由文本时携带「其他」回答。当 `custom` 存在时，`selected` 为空；自定义文本是对选中项的覆盖，而非补充。UI 也可以使用 `selected` 为空且不含 `custom` 的回答项，在其余问题均已完成的批次中保留被跳过的问题。

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

## 提供方

同一上下文中只能有一个活跃的提供方。提供方注册绑定到 effect，因此 HMR（热模块替换）或 dispose（资源释放）会移除当前活跃的 UI。

```ts type-equiv
/** UI-side provider for user questions. */
interface UserInteractionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}
```

## 错误

`UserInteractionError` 继承 `HarnessError`，因此 `ctx.tools.execute()` 会保留 `{ name, code }`，用于面向模型的工具失败，如 `EMPTY_QUESTIONS`、`NO_PROVIDER`、`ASK_ABORTED` 或 UI 侧取消。

```ts type-equiv
/** Stable error taxonomy for user-interaction failures. */
class UserInteractionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserInteractionError'
  }
}
```
