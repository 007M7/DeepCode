# @deepseek-ai/dsh-user-interaction

[English](README.md) | 中文

抽象用户交互 seam。它定义 `ctx.userInteraction`，供面向模型的工具或权限插件在需要暂停工作并询问人类决定时使用。

## 服务：`UserInteractionService`（ctx 键：`userInteraction`）

### 公开 API

- `ctx.userInteraction.registerProvider(provider): () => void` 注册 UI 侧提供方。同一上下文中只能有一个活跃提供方；dispose（资源释放）会将其注销。
- `ctx.userInteraction.ask(request): Promise<AskUserQuestionAnswer>` 向活跃提供方提问并等待回答。

### 关键类型

- `AskUserQuestionRequest`：`{ questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal? }`；`detail` 提供辅助文本，提供方会将其随问题一起渲染，而不会将其变成选项标签。
- `AskUserQuestionOption`：`{ label, description? }`。
- `AskUserQuestionIntent`：`{ kind: 'plan-review', approve }`；即下文的带标签呈现意图。
- `AskUserQuestionAnswer`：`{ answers: [{ id, selected, custom? }] }`。
- `UserInteractionProvider`：包含 `ask(request)` 的 UI 实现。
- `UserInteractionError`：`HarnessError` 的子类，包含 `EMPTY_QUESTIONS`、`BAD_INTENT`、`NO_PROVIDER`、`DUPLICATE_PROVIDER` 和 `ASK_ABORTED` 等代码。

对于单选题，`custom` 会覆盖选中的选项，且 `selected` 为空。对于多选题，`custom` 可以补充 `selected` 中的标签。UI 可以把跳过的条目保留为 `{ id, selected: [] }`，既维持现有回答形态，也保留该批次中的其他回答。

### 呈现意图

`intent` 声明某个问题本身就是一种已知形态的决策，因此认识该标签的 UI 可以照此呈现——`plan-review` 表示 `detail` 是一份待审阅的计划，`dsh-plan-mode` 会在 `exit_plan_mode` 的问题上设置它。意图只塑造呈现：遵循它的 UI 回答的仍是通用 UI 会发送的那些选项标签，不认识该标签的 UI 渲染通用选项列表，因此调用方两种情况下读到的都是同一种回答形态。`approve` 指名表示批准的标签，而不依赖选项顺序。有两项断言是任何类型都承载不了的，`ask()` 会以 `BAD_INTENT` 拒绝它们：`approve` 未命中该问题自身的任一选项，以及意图落在没有 `detail` 的问题上——而 `detail` 正是它自称在审阅的东西。

## 职责

这是接口包。`@deepseek-ai/dsh-tool-ask-user` 等面向模型的消费方依赖此 seam；Web 宿主运行时提供随产品交付的交互式实现。循环保持不变：工具调用等待 Promise，工具结果随后恢复正常的 agent loop（智能体循环）。

## 模型体验

间接地，通过 `dsh-tool-ask-user`：它会将成功的提供方回答保留为紧凑 JSON，或返回以下失败之一：`Error: ask_user_question was aborted before the user answered`、`Error: ask_user_question requires at least one question`、`Error: no user-interaction provider is registered` 或 `Error: <message>`。等待人类回答不会增加 token。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀的任何变更均由上述消费方负责。

## 已知限制与暂缓事项

- **每个上下文只能有一个提供方**：不支持路由或扇出到多个 UI；第二次注册会抛出 `DUPLICATE_PROVIDER`，未注册任何提供方时，`ask()` 会抛出 `NO_PROVIDER`，而不会降级。
- **词汇仅包含问题表单形态**：可供选择的选项加可选的自定义文本；更丰富的交互形态（文件选择器、diff 预览确认）尚无 seam 词汇。
