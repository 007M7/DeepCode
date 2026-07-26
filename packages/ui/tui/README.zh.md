# @deepseek-ai/dsh-tui

[English](README.md) | 中文

DeepSeek Harness agent（智能体）的交互式终端入口，基于 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) 构建。它要求 stdin 和 stdout 均为 TTY；脚本和 Loader pipe 应改用单次执行的 [`@deepseek-ai/dsh-cli-demo`](../../examples/cli-demo/README.md) app。

已实现的 [TUI 功能 Agent Note（agent 决策记录）](../../../.agents/notes/implemented/feature/2026-07-17-dedicated-full-screen-tui-front-door.md)持有终端入口决策；[文件引用自动补全 Agent Note](../../../.agents/notes/implemented/feature/2026-07-23-tui-file-reference-autocomplete.md)持有仅路径的 `@file` 行为；[终端状态快照 Agent Note](../../../.agents/notes/implemented/testing/2026-07-18-tui-terminal-state-snapshots.md)持有其验证策略。

支持 macOS、Linux 和 Windows 上的交互式终端。Windows 使用 pi-tui 原生控制台 VT 输入处理；[Windows 支持 Agent Note](../../../.agents/notes/implemented/feature/2026-07-20-windows-tui-support.md)持有平台决策与 ConPTY 进程验证。

本包（package）只持有交互式终端展示和输入。它注入 `agents`、[`commands`](../commands/README.md)、`llm`、`systemPrompt`、`tokenMeter`、`tools` 和 `userInteraction`，可选读取 `skills` 服务（仅在已挂载时存在），然后驱动由 app 或开发者代码创建或恢复的 agent。Agent 生命周期、持久化与模型侧 [`ask_user_question`](../tool-ask-user/README.md) 工具仍是独立组合项。

终端成功启动后，本包会提供终端本地的 `ctx.tui` 扩展服务。注入该服务的插件可以使用组件工厂和受限布局选项调用 `openOverlay()`；宿主会公开 viewport、语义化主题、显示文本转义、重绘、关闭和生命周期信号，但不公开 pi-tui 树、终端、焦点控制器或 overlay 句柄。插件 overlay、模型选择器和用户问题共用一个 FIFO 模态队列。每个请求都是调用方插件 fiber 的 effect，因此卸载会移除排队工作，或在清理结算前关闭可见工作；终端关闭会先卸载依赖项，再停止 pi-tui。Overlay 状态不会记录或回放。组件代码受信任，可以渲染 ANSI 样式，但必须通过 `host.display()` 处理不受信任文本。[交互式扩展 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-22-tui-interactive-extension-service.md)持有该边界和未采用的替代方案。

TUI 从活跃会话表层重建已恢复历史，渲染 Markdown 响应与 reasoning，将每个工具的 `presentCall` / `presentResult` 意图应用到终端、diff 或通用卡片，把最新的 `todo/write` 计划保留在编辑器上方，并在左下方宽键盘面板中展示 `ctx.userInteraction` 问题，包含进度、编号选项和对齐说明。最新记录的会话标题成为 header 副标题；标题不存在时使用 `welcome`，终端窗口标题则变为 `<session title> — <configured title>`。持久 `llm/retry` 事件会撤回失败步骤的实时 chunk，并在 transcript（文本记录）中渲染计划重试次数、延迟和失败；成功、耗尽与取消随后通过普通会话事件结算。Footer 会对每个已记录模型步骤的用量只计一次，包括失败尝试；对于没有用量 chunk 的日志，以已提交消息的用量回退。其空闲视图会比较 token-meter 压力与当前路由的 `ctx.llm.resolveModelContext()`；适配器没有容量元数据时显示 `context unknown`，并显示工具卡片模式、当前模型和 reasoning 状态。Agent 运行时，这些摘要会替换为已经过工作时间指示器和 `esc interrupt`。表层替换事件会重建 transcript，使经过压缩（compaction）的历史不会再次出现。

如果逻辑工作区标签与会话宿主目录不同，嵌入方可以提供 `TuiRuntime.formatCwd`。该覆盖只改变 footer 标签；工具仍使用会话 `cwd`。

在模型输出、会话事件、工具 presenter、问题、配置或诊断到达 pi-tui 的 ANSI 感知 renderer 或终端标题前，TUI 会把换行之外的 C0 和 C1 控制字符渲染为可见 `\xNN` 文本。这些来源无法添加终端控制序列；终端渲染与样式仍由 TUI 和 pi-tui 持有。

在 token 边界输入 `@` 会搜索会话工作目录下的文件和目录。没有路径的模糊查询使用可复用的有界工作区索引；包含 `/` 的查询直接列出该目录，选择文件夹后会保持补全开启以继续深入。含空白的路径会插入为 `@"path with spaces"`。选择文件只会插入其路径和一个尾随空格：TUI 不会读取文件、附加隐藏上下文，也不会把路径替换为引用对象。注册模型侧 `read` 工具后，TUI 会添加一条固定系统提示词指令，要求模型在需要显式路径内容时读取该路径。

挂载可选的 `ctx.sessionReferences` 后，同一个 `@` 菜单还会提供仅含元数据的会话候选项，插入 `@[label](dsh-session:<payload>)`，并在分派前准备所选快照。会话引用保持结构化，因为模型没有类似文件系统的工具可在稍后检索会话快照。准备期间会禁止重复提交，并在失败时恢复编辑器输入。TUI 会在异步准备后根据状态选择 `agent.steer()` 或 `agent.followup()`，因此空闲 followup 仍会分派 `agent/prompt-submit`，而轮次中的 steering 会在检查点加入且不触发该 hook。

Agent 运行时，普通编辑器提交会调用 `agent.steer()`；其他时候调用 `agent.followup()`。提交行以斜杠开头时会改为进入 `ctx.commands`：已知命令直接执行，未知命令产生警告，两条路径都不会自动到达模型。命令生产方可以显式调度 agent 工作；[`dsh-plan-mode`](../../plan/plan-mode/README.md#model-and-human-surfaces) 使用该契约实现 `/plan [message]`。TUI 将 `/help`、`/model`、`/clear`、`/reasoning`、`/tools`、`/redraw`、`/reload`、`/resume`、`/status` 和 `/exit` 注册为 agent 作用域定义；其他所有有效命令都会动态加入自动补全与 `/help`，`/skill:` 补全也相同。编辑器上方的状态行会报告 TUI 从会话事件派生的轮次阶段，包括等待首个 token、思考、响应或执行工具；它显示该阶段已经过时间和运行中的步骤总数，每秒刷新，并以 `Enter sends steering, Esc cancels` 提示结尾。Steering 消息等待到达模型期间，会在提示前插入 `N queued ·` 徽标，每条消息排空后随即清除。Ctrl+C 或 Escape 会取消运行中的轮次。工具卡片把长主体折叠为可配置的头尾预览；Ctrl+O 在预览与完整输出之间切换所有卡片。Ctrl+R 切换 reasoning，Ctrl+L 重绘，Ctrl+D 在空闲时退出。

`/model` 将建议性的 `ctx.llm` catalog 打开为键盘选择器：Up/Down 移动，Enter 选择，Escape 关闭。`/model <model>` 仍可直接选择无歧义的模型 id，`/model <provider>/<model>` 则选择精确目标。已配置目标或最新记录的请求 header 会初始化选择器；由于 catalog 仅提供建议，未列出的当前模型仍会显示。选择仅对本 TUI 会话有效。提示词组装会为一个步骤建立目标快照，替换 `{{provider}}` 和 `{{model}}`，并通过 `agent/request` 应用同一组值；因此组装期间的切换会从后续步骤开始生效。请求 header 会持久记录真正到达模型的目标，未使用的选择则只存在于进程本地。

`/reload`（实验性，仅开发环境）会重新读取所有基于文件的 loader 配置树，并把 diff 应用到运行中 app：它手动调用 HMR（热模块替换）watcher 的配置路径；上下文中必须有 cordis Loader，否则退化为警告。它只在 agent 空闲时运行，并拒绝 reload 进行期间的再次进入。模块源代码热重载仍由 watcher 持有。挂载 `skills` 服务后，`/skill:<name> [instructions]` 会把该 skill 的指令作为一个 user 轮次加载到会话中；自动补全列出模型可调用的 skill，任何 skill（包括模型禁用的 skill）都可通过精确名称加载。

Footer 将会话报告的用量汇总为 `↑<uncached input> ↓<output>`；任何输入计费后，后面会显示 `cache <rate>%`，表示提供方缓存服务的已计费提示词 token 占比（未缓存输入加缓存读写），并四舍五入为百分比。它还会比较 token-meter 压力与当前路由的 `ctx.llm.resolveModelContext()`（适配器没有容量元数据时省略上下文占比），并显示当前模型和工具卡片模式；footer 过窄时，右侧会优先裁剪。

`/status` 会向 transcript 添加一张时间点诊断卡片，并在 agent 运行时保持可用。它报告会话 id、标题、工作目录、所选提供方／模型、reasoning 块可见性、agent 状态、事件／轮次／步骤／工具调用计数、精确输入／输出／缓存 token bucket、KV-cache 命中率、token-meter 上下文用量与容量、创建时间和最新事件时间。缺失标题、模型、缓存输入或上下文容量时会明确标记，而非推断。该卡片只存在于终端，不会重复紧凑 footer。

`/resume` 会针对当前工作区打开全 viewport 键盘选择器，而非居中对话框。获得焦点的搜索字段紧跟搜索 glyph 开始，并发出 pi-tui 的 cursor marker，使终端 IME 组合保持锚定在字段内。候选项按最近记录的活动排序，可按日志支持的标题或会话 id 搜索；每行报告 current/live/persisted 状态、上一轮次结果、近期提供方／模型，以及存在时的持久目标阶段。Up/Down 与 Page Up/Page Down 导航，Enter 恢复，Escape 会先清除非空搜索，再次按下才取消，Ctrl+C 则直接取消。当前会话、已在本运行时中活跃的会话、不可读日志、cwd 不匹配或日志所记提供方没有当前适配器的会话仍会显示，但不可选择。选择时会重复这些检查，并要求当前 agent 空闲，随后 flush 当前会话。TUI 接着停止终端 UI，并调用由宿主持有的可选 `TuiRuntime.handoffResume`；存在 `process.execve` 时，发布的 `dsh` 宿主会对 app 执行 dispose（资源释放）并替换自身进程。恢复操作保留相同的 `SessionId`、transcript、标题、todo 和持久目标；目标激活仍保持解除，TUI 会要求用户确认或执行 `/goal resume`。

`resumeCommand` 仍是部署持有的回退行为：只有当前会话已持久化后，退出才会打印它；不支持原地 handoff 的宿主会显示所选会话的命令。`{session}` 展开为会话 id。TUI 代码绝不会执行模板或任意 shell 文本。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `welcome` | 未设置 | 会话出现已记录标题前使用的 banner 副标题行；未设置时，banner 进入时没有副标题 |
| `sessionId` | `main` | 由终端驱动的精确共享 agent／会话身份 |
| `showReasoning` | `true` | 渲染 reasoning 块 |
| `maxToolOutputLines` | `6` | 折叠工具卡片的头尾预览所保留的输出行数 |
| `maxQuestionOptions` | `8` | 问题面板中可见的选项数 |
| `maxModelOptions` | `8` | 模型选择器中可见的模型数 |
| `maxResumeOptions` | `8` | 恢复选择器中可见的会话数 |
| `questionDialogWidth` | `200` | 问题面板宽度（列数），以终端宽度为上限 |
| `questionDialogMaxHeight` | `20` | 问题面板最大行数 |
| `modelDialogWidth` | `72` | 模型选择器宽度（列数） |
| `modelDialogMaxHeight` | `20` | 模型选择器最大行数 |
| `fileSearchMaxResults` | `20` | 一次 `@` 查询显示的最大文件和目录候选数 |
| `fileSearchMaxEntries` | `10000` | 无路径模糊查询使用的有界工作区索引最多保留的路径数 |
| `fileSearchExcludedDirectories` | `['.git', 'node_modules']` | 遍历和直接补全时忽略的目录 basename |
| `showHardwareCursor` | `false` | 在 pi-tui 的 IME marker 处显示硬件 cursor |
| `color` | `true` | 应用内置 ANSI palette（参见[颜色](#color)） |
| `title` | `DeepSeek Harness` | 终端窗口标题的产品后缀。 |
| `resumeCommand` | 未设置 | 供退出提示和不支持原地 handoff 的宿主使用的 shell 命令模板，其中 `{session}` 会展开为会话 id |

```yaml
- id: terminal
  name: '@deepseek-ai/dsh-tui'
  config:
    welcome: 'Coding agent ready.'
    sessionId: main-session-123
    showReasoning: true
    maxToolOutputLines: 6
    fileSearchExcludedDirectories: ['.git', 'node_modules', 'dist']
```

任一进程流不是 TTY 时，启动会在挂载前失败。组合 app 必须先挂载 TUI，再挂载由配置创建的 agent，使入口能够观察 `agent-loop/config-start-failed`；完全匹配会话的失败会在全屏模式启动前写出并以状态 1 退出，而不是留下空白终端。dispose 会停止接收扩展请求，卸载 `ctx.tui` 提供方及其依赖插件，中止运行中的命令，移除 TUI 定义，停止 loader，拒绝待处理问题，排空终端输入，恢复终端状态，注销事件 listener 和用户交互提供方，并且绝不会在 HMR 期间退出替换进程。

## 颜色

Palette 使用标准 16 色 ANSI 前景色和 SGR 属性，每个终端都会将其重新映射到当前配色方案，因此浅色与深色背景下都保持可读。正文使用终端默认前景色，而非固定色调。成组区域（用户提示词、工具卡片）使用彩色左侧 gutter bar，而非填充背景块；问题面板使用粗体强调色文本突出活跃行，选择器则使用反色。所有效果都只作用于前景色，因此不会与终端背景冲突。设置 `color: false` 可移除所有样式。

## 模型体验

### 交互式提示词输入

#### 模型看到的内容

每次非空普通编辑器提交都会成为一个文本块；目标 agent 空闲时通过 `agent.followup()` 发送，运行时通过 `agent.steer()` 发送。会话 mention 会变为可读的 `@label` 文本，加上由 [`dsh-session-reference`](../../context/session-reference/README.md) 定义的持久不受信任上下文；其完整 JSON 隐藏在紧凑引用卡片之后。斜杠命令和按键绑定仅用于 TUI；命令结果仍是终端通知。命令生产方可以调度单独的 agent 输入，例如 `/plan [message]` 接受的可选消息。

#### Token 影响

提交的文本会按 agent loop 的普通会话历史与压缩规则保留。Header、已记录标题、卡片、Markdown 渲染、状态行、计划和帮助文本不会增加 token。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 文件引用自动补全

#### 模型看到的内容

所选文件仍是普通 user 文本，例如 `@src/index.ts` 或 `@"docs/design notes.md"`；自动补全不会添加内容块、持久上下文或特殊引用 payload。注册 `read` 后，此 TUI agent 的每个请求还会包含下方固定系统提示词段落。模型会判断任务是否需要文件内容，并在需要时通过普通工具循环调用 `read`；只有路径不能证明文件已经过检查。

##### 精确系统提示词文本

```markdown
Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.
```

#### Token 影响

自动补全本身不增加 token。所选路径只贡献普通 user 文本 token；`read` 可用时，固定指令会贡献系统提示词 token。只有模型选择的 `read` 调用返回文件内容后，这些内容才会占用上下文。

#### KV Cache 影响

固定指令属于稳定系统提示词前缀，可以跨轮次复用。每个所选路径都是仅追加 user 文本；后续 `read` 结果通过普通工具 transcript 追加所请求内容。

### 会话模型选择

#### 模型看到的内容

`/model` 命令文本和键盘选择器输入均不会记录或发送。新步骤会在提示词变量和请求路由中同时收到所选提供方／模型对。

#### Token 影响

选择器不会添加消息。更改目标可能改变插值后的系统提示词文本，并把后续请求发送给所选模型。

#### KV Cache 影响

更改提供方或模型会进入该目标的缓存域；不假定不同目标间可以复用缓存。

### 手动调用 skill

#### 模型看到的内容

提交 `/skill:<name> [instructions]` 会加载具名 skill，并交付一个文本块：用 `<skill name="…">` 元素包装 skill 指令；提供方公开资源基准时，会先添加一行定位 skill 相对资源；最后附上用户输入的尾随指令。交付遵循普通输入同样的空闲时 followup、运行时 steer 规则。选择 skill 的是命令而非模型；模型禁用的 skill 不出现在自动补全中，但仍可按精确名称加载。

#### Token 影响

渲染后的 skill 块与尾随指令会作为一个 user 轮次保留，并遵循 agent loop 的普通会话历史和压缩规则；重复调用会再次追加正文。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 交互式用户问题回答

#### 模型看到的内容

消费方调用 `ctx.userInteraction.ask()` 时，此提供方会按顺序显示各个问题，并返回选中选项标签或 `custom` 文本。中止、取消或 UI dispose 会变为 `Error: ask_user_question was interrupted before the user answered`；该转换由 `dsh-tool-ask-user` 完成。

#### Token 影响

等待和终端 overlay 不增加 token；已解析回答或错误只会通过调用工具或插件的结果对模型可见。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

- **恢复功能没有跨进程会话锁**：选择器会拒绝本运行时中已知处于活跃状态的会话，但另一个进程可以在 handoff 之前或期间恢复同一持久 id。能够运行并发宿主的部署必须在 TUI 外协调所有权。
- **一个已配置会话持有 transcript 和编辑器**：其他 agent 的问题仍可使用共享 overlay 提供方，但会话渲染与提示词输入仍绑定到 `sessionId`。
- **工具卡片是文本终端展示**：终端、diff 与通用卡片使用工具持有的标题／内容，但会话内容目前没有用于内联图像渲染的图像块。
- **有意不支持非 TTY 运行**：需要自动化的 app bundle 必须组合单次执行或服务器入口（`dsh-cli-demo`、`dsh-acp`），而不能依赖内部回退。
- **手动 `/skill:` 调用总会重新加载完整 skill 正文**：TUI 不会检测会话中是否已存在某项 skill，因此重复调用会再次追加其指令。
- **文件发现只发现宿主工作区**：自动补全读取 TUI 进程的会话 `cwd`，所选文本随后由已配置 `read` 工具解释。挂载远程或虚拟文件系统的部署必须对齐这些 namespace，或提供其他补全接口。
- **文件搜索使用显式目录排除项，而非 ignore 文件**：默认排除 `.git` 和 `node_modules`，部署还可以配置更多 basename，但不会解释 `.gitignore` 和 `.ignore`。目录 symlink 不会遍历。
