# 用户交互

[English](user-interaction.md) | 中文

[dsh-user-interaction](../../packages/ui/user-interaction) 的用户交互 seam。它是工具或权限插件在需要人类回答后 agent 才能继续时所使用的提供方无关词汇。UI 表面提供活跃的 `UserInteractionProvider`：`dsh-stdio-demo` 在 readline 中渲染问题，`dsh-acp` 将其映射为 ACP 表单引出。

源码：[`packages/ui/user-interaction/src/index.ts`](../../packages/ui/user-interaction/src/index.ts)

## 问题选项

`AskUserQuestionOption` 是可选择项的形状。`label` 是面向用户的选项文字，同时也是模型侧选中后的值；`description` 是可选的 UI 辅助文字。

```ts type-equiv
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## 问题条目

`AskUserQuestionItem` 是请求中的一个问题。模型提供一个稳定的 `id`，回答时原样回传，使批量问题可路由。

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

## 提问请求

`AskUserQuestionRequest` 是跨包请求。`questions` 是数组，这样 UI 可以在一次流程中展示相关问题，同时为每个回答保留稳定的 id。

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

## 回答

提供方为每个已回答的问题 id 返回一条回答。`selected` 包含选中的选项 label，`custom` 在用户输入了自由文本"其他"答案时携带该内容。当 `custom` 存在时，`selected` 为空；自定义文本是对选中项的覆盖，而非补充。

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

## 提供方

同一上下文中只能有一个活跃的提供方。提供方注册与 effect 绑定，因此 HMR（热模块替换）或 dispose（资源释放）会移除活跃的 UI。

```ts type-equiv
interface UserInteractionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}
```

## 错误

`UserInteractionError` 继承 `HarnessError`，因此 `ctx.tools.execute()` 会为面向模型的工具失败保留 `{ name, code }`，例如 `EMPTY_QUESTIONS`、`NO_PROVIDER`、`ASK_ABORTED` 或 ACP 侧的取消。

```ts type-equiv
class UserInteractionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserInteractionError'
  }
}
```
