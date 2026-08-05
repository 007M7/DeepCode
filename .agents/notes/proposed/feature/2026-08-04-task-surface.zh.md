# Agent Note: 用于结构化会话交互的 Task Surface

Status: proposed

[English](2026-08-04-task-surface.md) | 中文

## 问题

有些任务很难通过交替发送文本消息来完成。比较多个选项、调整计划顺序、审阅表格，或填写一小组关联字段，都更适合在一次结构化交互中处理。目前，agent（智能体）可以描述这类交互，但若不增加永久的产品组件或生成可执行的客户端插件代码，就无法要求 Web 客户端渲染这类交互。

这两种变通方案的职责归属都不合理。产品专用组件要求每种任务形态都新增触发方式并发布新版本。对于只需一个轮次的表单，生成代码所拥有的权限和生命周期成本都远超实际需要。这样做还会把展示界面而非用户结论变成持久产物。

目前缺少这样一份契约：用有界、可回放的描述来定义临时 UI，并让它只属于一个会话和一次工具调用实例。产品应当负责校验、放置、交互机制和提交；agent 应当负责特定任务的文案、数据，以及从受支持组件中作出选择。

## 提案

新增 **Task Surface**：一种由普通 Web 客户端插件渲染、带版本的声明式模型。面向模型提供一个稳定工具 `show_task_surface`，用于发布该模型。调用成功后，当前轮次结束。用户编辑并提交渲染出的面板；Host 将提交内容记录为一条普通的可见用户消息，并开始下一轮。

同时满足以下条件时，Task Surface 是默认的结构化 UI 路径：

- 交互属于当前会话和当前任务；
- 行为可以由已声明的组件集合表达；
- 不需要后台执行或新增运行时权限；
- 有价值的持久结果是用户提交的结论，而不是面板本身。

这里定义的是一个触发方式，不是一组产品启发式规则。agent 会显式调用 `show_task_surface`。用户可以通过普通语言要求 agent 使用 Task Surface。产品不会根据工具名称或任务主题打开专用面板；重复使用也不会自动把 Task Surface 转为插件。

简短的阻塞式问题仍由 [`ask_user_question`](../../implemented/feature/2026-07-29-ask-question-web-presentation.md) 处理。纯文本说明仍留在聊天中。跨会话导航、后台行为、新服务或持久自定义 UI 则属于 Generated Client Plugin 工作流。

## 声明式模型

`TaskSurfaceModelV1` 使用 JSON。它包含内容块、输入字段和一个提交标签；不包含代码、回调、选择器、HTML、CSS、可执行产物的 URL，也不包含表达式语言。该类型与核心会话中现有的 `SurfaceManager`/`SurfaceOp` 消息归约类型无关；Task Surface 是一套产品交互协议。

```ts ignore-check
interface TaskSurfaceModelV1 {
  version: 1
  title: string
  description?: string
  sections: TaskSurfaceSection[]
  fields?: TaskSurfaceField[]
  submit: { label: string }
}

interface TaskSurfaceSection {
  id: string
  title?: string
  layout?: 'stack' | 'grid'
  columns?: 2 | 3
  blocks: TaskSurfaceBlock[]
}

type TaskSurfaceBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'metrics'; items: { label: string; value: string; detail?: string }[] }
  | { kind: 'table'; columns: { id: string; label: string }[]; rows: Record<string, string | number | boolean | null>[] }
  | { kind: 'diff'; path?: string; before: string | null; after: string; language?: string }
  | { kind: 'notice'; tone: 'neutral' | 'info' | 'warning'; text: string }

type TaskSurfaceField =
  | { kind: 'text'; id: string; label: string; multiline?: boolean; required?: boolean; initial?: string }
  | { kind: 'choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string }
  | { kind: 'multi-choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }
  | { kind: 'toggle'; id: string; label: string; initial?: boolean }
  | { kind: 'order'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }

interface TaskSurfaceOption { id: string; label: string; detail?: string }
```

渲染器控制字体排印、间距、响应式布局、焦点顺序、键盘行为和主题 token。`grid` 是布局提示：可用宽度无法容纳所要求的列数时，渲染器会将其折叠。Markdown 使用产品支持的 Markdown 子集。遇到未知版本或联合类型分支时，系统使用通用工具结果回退，而不是只解释其中一部分。

版本 1 有意不支持条件字段、客户端数据获取、图表、文件上传和任意事件处理器。新增任何块或字段类型都属于协议变更，必须在同一变更中加入解析器、渲染器、无障碍行为、回退方式和回放 fixture（测试前置数据）。

Task Surface 服务通过受 schema 校验的配置定义限制。初始默认值为：规范化模型不超过 64 KiB、块不超过 64 个、字段不超过 32 个、表格行不超过 200 行、提交内容不超过 32 KiB。模型内的 ID 必须唯一；字段值必须符合其声明；未知字段会被拒绝。这些限制约束日志、DOM 和提示词成本，但不改变协议。

## 工具与呈现契约

`show_task_surface` 接收 `{ model: TaskSurfaceModelV1 }`。Host 解析并规范化完整模型；若该会话已有一个打开的 Task Surface，则拒绝调用；否则生成 `surfaceId`，并返回带规范化模型的规范值 `{ surfaceId, model }`。`presentationMeta` 持久化 `value.model`，使投影器和执行器不会对规范化结果产生分歧。Native 结果会指明该 Surface，并说明客户端无法渲染面板时，可以通过普通消息绕过它。随后工具调用 `exec.concludeTurn()`，防止 agent 越过所要求的人工检查点继续执行。

工具定义设置 `exclusive: true`，并且只会组装到同时挂载 Host 服务和 Web 渲染器的 Web profile 中。版本 1 支持 `native` 和 `both` 工具模式；仅支持 `code` 的 profile 不会向模型公布该工具，因为 Code Mode 分发属于嵌套调用，无法把呈现元数据传到外层结果。

根据[规范工具输出契约](../../implemented/architecture/2026-07-20-canonical-tool-output-contract.md)，规范值仅存在于本次执行中。因此，回放通过 `output.presentationMeta(args, value)` 将以下带标签的载荷随 `tool/result.meta` 一并持久化：

```ts ignore-check
interface TaskSurfacePresentationMeta {
  kind: 'dsh/task-surface'
  version: 1
  surfaceId: string
  model: TaskSurfaceModelV1
}
```

该工具保留通用 [render intent](../../implemented/architecture/2026-07-02-tool-render-intent-union.md)。带 key 的 Web 行读取 `ToolResultNode` 上已经保留的带标签元数据，无需新增 render-intent 分支或呈现注册表。不支持 Task Surface 的客户端会渲染普通结果内容。

Web 插件遵循 [toolview](../../implemented/architecture/2026-07-23-toolview-dissolution.md) 和 [slot 注册](../../implemented/architecture/2026-07-22-slot-type-chain-implementation.md)契约，为 `show_task_surface` 静态注册一个带 key 的 `conversation.chat.toolview` 条目。结算后，该行显示简洁摘要，并在行内展开声明式面板。模型不能选择会话标签页、详情栏、模态框、像素位置或 z-index。以后即使改变放置位置，也只是渲染器的决策，不会改变日志中记录的模型。

## 提交契约

Task Surface 领域通过 Host 传输层公开三个操作。只有 `submit` 会接纳用户消息：

```ts ignore-check
type TaskSurfaceSubmissionId = string & { readonly __brand: 'TaskSurfaceSubmissionId' }
type TaskSurfaceDismissalId = string & { readonly __brand: 'TaskSurfaceDismissalId' }

interface TaskSurfaceService {
  getActive(input: { sessionId: SessionId; surfaceId: string }): Promise<GetActiveTaskSurfaceResult>
  submit(input: SubmitTaskSurfaceRequest): Promise<SubmitTaskSurfaceResult>
  dismiss(input: DismissTaskSurfaceRequest): Promise<DismissTaskSurfaceResult>
}

interface SubmitTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: string
  submissionId: TaskSurfaceSubmissionId
  values: Record<string, JsonValue>
  note?: string
}

type SubmitTaskSurfaceResult =
  | { accepted: true; messageId: MessageId }
  | { accepted: false; reason: 'not-open' | 'stale' | 'invalid-submission' }

type GetActiveTaskSurfaceResult =
  | { active: true; callId: CallId; surfaceId: string; model: TaskSurfaceModelV1 }
  | { active: false; reason: 'not-open' }

interface DismissTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: string
  dismissalId: TaskSurfaceDismissalId
}

type DismissTaskSurfaceResult =
  | { dismissed: true; eventSeq: number }
  | { dismissed: false; reason: 'not-open' | 'stale' }
```

Host 解析出 `show_task_surface` 的确切成功调用实例，依据其已持久化模型重新校验提交值，并通过普通会话队列接纳响应。该响应成为一条用户角色消息，并使用可合并扩展的消息来源：

```ts ignore-check
interface TaskSurfaceCorrelation {
  version: 1
  submissionId: TaskSurfaceSubmissionId
  callId: CallId
  surfaceId: string
  values: Record<string, JsonValue>
}

interface TaskSurfaceUserMessageSource {
  kind: 'user'
  rpcId: RpcId
  taskSurface: TaskSurfaceCorrelation
}
```

浏览器安全的领域包拥有 `TaskSurfaceCorrelation` 及其带品牌类型的 `submissionId`。ApiProxy 拥有传输扩展，负责将其与 `rpcId` 组合。保留 `kind: 'user'` 可维持普通用户消息气泡和提示词语义，额外字段则提供持久关联信息。消息内容是由产品格式化的可读摘要，包括面板标题、标签和提交值，以及可选备注。模型接收相同的文本。结构化来源不是第二条隐藏指令。

产品外壳负责收起和关闭。收起属于本地视图状态，不会发送任何内容。`taskSurface.dismiss({ sessionId, surfaceId, dismissalId })` 追加一个 `task-surface/dismissed` 会话事件，但不启动轮次；该精确事件会关闭投影并更新 transcript（文本记录）中的对应行。重试会复用 `dismissalId` 并返回原始结果，不会再追加一个事件。

客户端边界上的提交具有事务性。接纳进行期间，面板会禁用提交；只有匹配的用户消息持久化后，才会清除已持久化的草稿。若请求被拒绝，则保留值供用户继续编辑，并显示返回的原因。双击和传输重试会复用 `submissionId`；对于一个已接受的 Surface，Host 只会接纳一条用户消息。

队列接纳与 `user/message` 持久化之间存在一个短暂区间。因此，通用排队消息 DTO 会保留 `Message.source`。带有匹配 Task Surface 关联信息的排队消息会使面板维持禁用状态；如果该队列项被丢弃，待处理状态会清除，草稿恢复为可编辑状态。在同一区间，Host 会持有一个进程内 single-flight 占用，并在消息提交持久化、接纳被拒或队列项被丢弃时释放。队列属于协调状态，并不是第二份持久生命周期记录。

## 生命周期与恢复

会话日志是真源。现有[会话投影系统](../architecture/2026-07-27-session-projection-and-command-log.md)中的一个小型 `taskSurface` 单元会折叠成功调用的 Surface 结果元数据和后续用户消息来源，得到以下状态：

```ts ignore-check
interface TaskSurfaceProjection {
  active: { callId: CallId; surfaceId: string } | null
}
```

一个会话最多只能有一个打开的 Task Surface。成功的结果会打开它；匹配的 Task Surface 用户消息或关闭事件会将其关闭。后续的普通用户消息也会将其关闭，这是一条显式的绕过路径；在以上任一事件关闭活动调用实例前，再次调用 `show_task_surface` 都会失败。回退和 fork 会通过折叠相应日志推导出活动调用实例，不会使用独立的 Surface 数据库。

完整模型仍存放在对应的 `tool/result.meta` 中；投影只携带活动身份。当该结果超出已加载的历史窗口时，`taskSurface.getActive({ sessionId, surfaceId })` 会从会话日志中读取确切调用实例，重新校验元数据后返回 `{ callId, surfaceId, model }`。调用实例不存在或已经关闭时返回 `not-open`。因此，刷新和重新连接不要求活动结果位于历史尾段，也无需把模型复制到每一个投影基线中。

Web 插件将未提交值保存在一个有界、按会话持久化的 slot store 中，并以 `surfaceId` 为 key；这些值永远不会进入会话日志、提示词或长期记忆。已提交值存放在接纳的用户消息中，因此即使浏览器草稿丢失，也不会抹去结论。

## 包边界与依赖

该能力按职责变化处分包：

| 包 | 职责 |
|---|---|
| `packages/task-surface/task-surface` | 浏览器安全的模型／类型和关联信息、解析器、限制、提交校验器／格式化器、会话事件扩展、投影单元，以及 Host 服务契约 |
| `packages/task-surface/tool-task-surface` | `show_task_surface`、规范输出、呈现元数据、通用 render intent、活动 Surface 检查和 `concludeTurn()` 行为 |
| `packages/client/ui-task-surface` | 静态带 key 的工具行、声明式 Web 渲染器、按会话划分的草稿 store，以及提交客户端 |
| `packages/host/apiproxy` | 类型化的活动 Surface 读取／提交／关闭传输、用户消息来源扩展和排队来源传递；将校验与接纳委托给 Task Surface 服务 |

该实现依赖现有的消息日志、规范工具输出、带标签的 render intent、会话投影、按会话作用域声明的 slot store 和 slot 生命周期，不依赖在运行时创建客户端插件。Generated Client Plugin 工作流可以使用 Task Surface 展示审阅表单，但两个协议都不拥有或激活另一个协议。

## 交付阶段

1. 实现模型／解析器、投影单元、`show_task_surface`、呈现元数据、静态 Web 行，以及带只读块的通用回退。
2. 增加字段、持久化草稿、经 Host 校验的提交／关闭、排队来源传递，以及可见用户消息接纳。
3. 只增加有实际任务依据，并且拥有至少两个消费方或明确通用回退的组件类型。一个单独的显式用户操作可以启动生成式插件编写工作流，但只会创建候选项，绝不会直接推广代码。

## 考虑过的替代方案

**增加产品专用触发方式和面板。**不予采用，因为每种新任务形态都会把 agent 行为与已发布的产品组件耦合。产品代码应当定义一套接纳的组件词汇和放置策略；agent 则显式地从中选择。

**从工具调用中渲染任意 HTML、CSS 或 JavaScript。**不予采用，因为这会把临时交互变成可执行的客户端插件代码，却不具备代码所需的构建、预览、评估、批准或回滚生命周期。

**使用大型表单扩展 `userInteraction.ask()`。**本契约不采用这种做法。`ask()` 是一种阻塞式请求／响应操作，适用于正在运行的工具必须先获得简短答案才能继续执行的情况。Task Surface 会结束当前轮次，可以在刷新后继续保持打开，并把结果提交为下一条可见用户消息。

**每次调用都注册一个动态 `conversation.view`。**不予采用，因为视图账本是全局的，而其渲染作用域按会话划分；同时，临时任务身份会变成注册身份。单个静态带 key 的 toolview 会将调用实例数据保留在归属它的已记录调用中。

**只在规范工具值中保留模型。**不予采用，因为规范值不会持久化。回放要求将规范化模型写入 `presentationMeta`。

**将面板存入长期记忆。**不予采用，因为布局和草稿状态不是可复用事实。现有记忆策略可以保留用户提交的结论。

## 验收标准

- 在 `native` 或 `both` 工具模式下，真实模型可以调用一个稳定的 `show_task_surface` schema；调用结束当前轮次；具备相应能力的 Web 客户端在实时运行和回放后都能渲染同一份规范化模型；仅支持 `code` 的模式不会向模型公布该工具。
- 每个 `submissionId` 的提交操作恰好生成一条可见用户消息，通过普通队列接纳开始下一轮，并在保留 `source.kind: 'user'` 的同时维持对确切调用实例的关联；关闭操作记录一条日志事件，且不启动轮次。
- 刷新、重新连接、会话切换、fork 和回退都生成日志所决定的生命周期状态；`getActive` 可以恢复历史尾段之外的模型，任何面板都不会泄漏到其他会话。
- 不受支持的版本、格式错误的元数据以及客户端能力缺失时，系统回退到带普通消息绕过路径的可读工具结果内容；嵌套调用以及已有另一个活动 Surface 时发起的调用都无法打开 Surface，并以失败结束。
- 解析器会在面板可交互前强制校验 ID、联合类型形态、字段值以及配置的字节数和数量限制。
- 组件测试覆盖纯键盘操作、焦点恢复、无障碍名称、窄屏布局、两种主题，以及中英文产品界面。
- 无密钥浏览器组合测试覆盖显示、编辑、接纳被拒后的重试、排队／丢弃提交、持久提交、关闭、刷新恢复和双重提交幂等性。
- 前缀快照表明：无论任务特定模型如何变化，都只存在一个稳定的工具定义；只有调用参数和后续用户结论发生变化。
- 卸载 Web 插件时，其所属 Fiber 会对工具行和草稿 store 执行 dispose（资源释放），但不会改变持久 transcript。

## 风险

第一批组件可能小到无法满足实际任务，也可能大到足以演变成一个粗糙的应用框架。是否新增组件应由使用证据决定；v1 不提供表达式语言或网络行为。

即使设置了字节限制，大型表格和 Markdown 仍可能生成开销较高的 DOM。渲染器必须按需虚拟化或截断内容，同时保留可读回退和明确计数。

填写字段较多时，由产品格式化的提交消息可能过长。格式化器需要使用确定性的紧凑格式，保留每一个提交值，同时避免重复完整显示模型。

浏览器本地持久化的草稿可能保留敏感的未提交文本。store 需要遵守规定的字节上限、使用按会话划分的 key、在提交成功后显式清除，并采用与现有会话草稿相同的存储策略。
