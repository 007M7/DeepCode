# @deepseek-ai/dsh-user-interaction

[English](README.md) | 中文

抽象用户交互 seam。它拥有 `ctx.userInteraction`：当面向模型的工具或权限插件需要暂停工作并询问人类决定时所使用的服务。

## 服务：`UserInteractionService`（ctx 键：`userInteraction`）

### 公开 API

- `ctx.userInteraction.registerProvider(provider): () => void` 注册 UI 侧提供方。同一上下文中只能有一个活跃提供方；dispose（资源释放）会将其注销。
- `ctx.userInteraction.ask(request): Promise<AskUserQuestionAnswer>` 向活跃提供方提问并等待回答。

### 关键类型

- `AskUserQuestionRequest`：`{ questions: [{ id, question, detail?, header?, options?, multiSelect? }], agent?, signal? }`；`detail` 提供辅助文本，提供方会将其随问题一起渲染，而不会将其变成选项标签。
- `AskUserQuestionOption`：`{ label, description? }`。
- `AskUserQuestionAnswer`：`{ answers: [{ id, selected, custom? }] }`。
- `UserInteractionProvider`：包含 `ask(request)` 的 UI 实现。
- `UserInteractionError`：`HarnessError` 的子类，包含 `EMPTY_QUESTIONS`、`NO_PROVIDER`、`DUPLICATE_PROVIDER` 和 `ASK_ABORTED` 等代码。

当回答包含 `custom` 时，`selected` 为空；自定义文本会覆盖所选选项，而不是补充它们。UI 可以把跳过的条目保留为 `{ id, selected: [] }`，既维持现有回答形态，也保留该批次中的其他回答。

## 职责

这是接口包（package）。`@deepseek-ai/dsh-tool-ask-user` 等面向模型的消费方依赖此 seam；`dsh-tui` 和宿主运行时提供交互式实现。循环保持不变：工具调用等待 Promise，工具结果随后恢复正常的 agent loop（智能体循环）。

## 模型体验

间接地，通过 `dsh-tool-ask-user`：它会将成功的提供方回答保留为紧凑 JSON，或返回以下失败之一：`Error: ask_user_question was aborted before the user answered`、`Error: ask_user_question requires at least one question`、`Error: no user-interaction provider is registered` 或 `Error: <message>`。等待人类回答不会增加 token。

#### KV Cache 影响

不会直接使缓存失效；具名消费方拥有所有请求前缀变更。

## 已知限制与延期工作

- **每个上下文只能有一个提供方**：不支持路由或扇出到多个 UI；第二次注册会抛出 `DUPLICATE_PROVIDER`，未注册任何提供方时，`ask()` 会抛出 `NO_PROVIDER`，而不会降级。
- **词汇仅包含问题表单形态**：可选选项加可选自定义文本；更丰富的交互形态（文件选择器、diff 预览确认）尚无 seam 词汇。
