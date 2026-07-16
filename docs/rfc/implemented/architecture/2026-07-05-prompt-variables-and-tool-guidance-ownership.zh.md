# RFC：提示词变量与工具指导归属

Status: implemented

[English](2026-07-05-prompt-variables-and-tool-guidance-ownership.md) | 中文

## 问题

组装后的系统提示词有四个缺陷，同属一类：harness 已经掌握的事实在别处被手工重述，然后漂移。

**模型无法知道自己的名字。** `AgentOptions.model` 驱动每次请求，但没有任何提示词文本携带它——也不可能携带：`dsh-system-prompt` 中的 section 是上下文全局的，而模型名称是 per-agent 的，且 `assemble()` 根本不接受任何 per-agent 输入。

**工具指导是叶子 YAML 中的手写行文。** bash/subagent/todo_write 的使用指导存放在 `examples/coding-agent/cordis.yml` 和 `examples/acp-agent/cordis.yml` 的 `systemPrompt` 字符串中——两份漂移的副本（ACP 那份已经被删减）——而 `dsh-tool-fs` 和 `dsh-tool-web` 则以 `ctx.systemPrompt.section()` 贡献的方式持有各自的指导。加载或卸载一个工具插件意味着手动编辑每个部署的 persona；两份 YAML 都带着一条 `FIXME(config-comments)` 为这种割裂的症状道歉，stdio 的欢迎横幅也手动枚举了工具集。

**Persona 渲染在工具指导之后。** agent loop（智能体循环）将 `agent.options.systemPrompt` 字符串拼接在已组装的 section 之后，于是模型先读到「使用 read 工具……」再读到「你是 coding-agent」——与身份优先的惯例（Claude Code、Codex）相反，且在 section 流水线之外形成了第二条组合路径。

**Fork 工具的描述是假的。** `dsh-tool-subagent` 硬编码了一段为 spawn 语义撰写的描述——"a separate agent that works in its own context … it does not see this conversation"——而 `subagent_fork` 实例（其子 agent 继承父级已完成的轮次）拿到了同样的措辞；YAML 行文在带外纠正了这个谎言。小问题同族：`PromptSection.name` 文档写着"(diagnostics / dedup)"，但重复项被静默接受。

## 决策

**一条原则：提示词中的每个事实恰好有一个归属方。** 模型名称和工作区是配置/会话事实 → harness 将它们暴露为变量，persona 引用它们。每个工具的语义和何时使用 → 工具的 `description`。description 无法承载的跨调用习惯 → 工具包的 prompt section。harness 出处 → 静态的 `harness:identity` section。部署角色和行为 → 部署的 persona。

### 组装上下文

`SystemPrompt.assemble(context)` 接受一个可 merge 扩展的 `AssembleContext`。`dsh-system-prompt` 声明用于 scoped routing 的可选 `scope` 选择器，而 `dsh-agent` 通过 declaration-merge 将可选的类型化 `agent` 字段附加到其上（类型层面的 `agent → system-prompt` 边，无运行时依赖环）。循环在每一步调用 `assembleContextFor(agent)`，使两个字段标识同一个 agent；section 文本提供方可以读取该上下文，`system-prompt/assemble` waterfall（瀑布式事件）也会收到它，监听方可据此按 agent 过滤或扩展。

### 提示词变量

插件通过 `ctx.systemPrompt.variable(name, provider)` 注册 `{{name}}` 值。组装时将它们解析到 waterfall 可见的变量映射中。渲染阶段拒绝：未知的 own-property 引用、注册的 provider 返回 `undefined`、格式错误的完整引用、以及仍包含闭合 `}}` 的不平衡引用；孤立的未匹配 `{{` 保留为行文，替换后的值不会被再次扫描。注册阶段拒绝无效或重复的变量名，section 名称也必须唯一。

`dsh-agent-loop` 注册两个内置变量，均为上下文 agent 的纯投影：`model`（= `options.model`）和 `cwd`（= `session.header.cwd`）。示例 persona 写 `powered by the {{model}} model`——模型名称只在 `model:` 配置键中声明一次。`{{cwd}}` 仅在 ACP 示例中演示：每个 ACP 会话携带客户端的 cwd，而配置预创建的 stdio agent 没有 cwd（在那里声称 `{{cwd}}` 的 persona 会导致该轮次失败——这是有意为之）。变量留在 loop 插件上（不同于下文的 section）：它们是本循环所驱动的 agent 的运行时事实，替换循环自行提供自己的变量。

### Persona 作为 order-0 section

`dsh-system-prompt` 持有 order 为 `-100` 的 `harness:identity` 和 order 为 `0` 的已配置 `deployment:persona`，因此两者在替换循环时仍然存活。提示词渲染只有一条路径 `renderPrompt(assembly)`，`agent/pre-step` 因此能测量用于压缩（compaction）的确切提示词。agent 作用域的 `deployment:persona` 遮蔽全局默认值，允许 subagent 提供方在发布前安装 persona。约定的 order 分段为：identity `-100`、persona `0`、工具指导 `100–199`。

### 工具指导归属

每个工具的语义和选择指导存放在工具描述中。Prompt section 仅承载跨调用习惯，例如检查 bash 退出标记或优先使用文件系统工具而非 shell 命令。`todo_write` 和 subagent 工具不需要 section，因为它们的描述已包含完整契约。部署 persona 只包含角色和行为。

### Subagent 对话历史描述符

`SubagentProvider.inheritsParentContext` 描述的是对话种子，而非作用域、服务、工具或权限。spawn 和 ACP 将其设为 `false`；fork 设为 `true`。`dsh-tool-subagent` 根据该标志派生工具描述和 prompt 参数描述，包括 fork 继承已完成轮次但不继承进行中轮次这一事实。提供方生命周期事件使该措辞与响应式的 provider 注册保持同步；其设计动机见 [provider-lifecycle-events RFC](2026-07-05-subagent-provider-lifecycle-events.md)。

## 曾考虑的替代方案

- **循环自行组合一行身份文本**——在必须保持精简的那个包里硬编码面向模型的行文（"plugins, not loop changes"），且在 section 流水线之外形成第二条组合路径。（身份确实以代码字面量交付——但作为 `dsh-system-prompt` 注册的普通 section，其 `system-prompt/assemble` waterfall 仍是部署方需要移除它时的逃生阀。）
- **通过 `agent/request` waterfall 注入模型名称**——提示词文本在两处组合，且 `agent/pre-step` 的 `fullSystemPrompt` 会遗漏它，导致压缩（compaction）测量的提示词与模型实际看到的不一致。
- **在每个 persona 中手写模型名称**——与上方一行的 `model:` 键重复，配置修改后默默失实——正是本 RFC 要治的病。
- **宽松插值（未知引用保留原样或替换为空）**——一个拼写错误 `{{modle}}`（或一个空洞）会被送到模型，直到 transcript（文本记录）审查才有人注意到。
- **在配置中逐实例手写 subagent 措辞**——面向模型的行文重新回到每个部署 × 每个实例，又是同一个病。**按 provider 名称匹配措辞**——`providerName` 本身是配置，重命名 provider 后会静默拿到错误的措辞。
- **在 `apply` 时解析 provider（加载顺序要求）** 和 **仅用 section 承载 subagent 措辞（在 assemble 时惰性解析）**——provider 生命周期事件的替代方案；均在 [provider-lifecycle-events RFC](2026-07-05-subagent-provider-lifecycle-events.md) 中被否决。

## 不在范围内

- 更多变量（`date`、平台、git 状态）——注册表使每个变量成为拥有该事实的插件的一行贡献；本 RFC 不认领任何一个。
- 为预创建的 stdio agent 提供配置 `cwd`（可让 stdio persona 使用 `{{cwd}}` 并按真实路径分区持久化）——推迟到 session-cwd 方案重新讨论时。

## 交付的不变式

- coding-agent 提示词通过一条组装路径渲染：identity、带插值模型名的 persona，然后是 fs/bash/web 指导。
- fork 和 fresh subagent 的描述反映 provider 是否继承已完成的对话轮次；工具随 provider 生命周期变化而出现、消失和重新措辞。
- 未知、无值、格式错误或不平衡的变量引用会指名 section 并抛出异常；重复的 section、变量和工具注册也会抛出异常。
- 快照回放与提示词无关：它按轮次和步骤索引已录制的 chunk 流，不比较发出的请求。

## 后果

- 组装后的提示词中每个事实现在恰好有一个归属方，叶子 YAML 中手写的工具行文已消除：加载或卸载一个工具插件不再需要编辑任何部署的 persona。
- `{{model}}` 在组装时反映 `AgentOptions.model`。如果一个插件在 `agent/request` waterfall 中切换模型，提示词中的声明在该步骤就会过时；如果一个插件在那里**提供**模型（options.model 未设置——循环文档记载的回退路径），变量在渲染时无值，含 `{{model}}` 的 persona 会在 waterfall 运行前失败。两者的补救方式相同，且正是归属规则本身：拥有该延迟绑定模型事实的插件在 `system-prompt/assemble` waterfall 上提前声明它（`assembly.variables['model'] = …`）——一个归属方，两处声明；一个循环测试端到端固定了 supply 路径。已接受。
- 当一个已绑定的 provider 不在位（尚未激活、已卸载、HMR（热模块替换）重载中）时，subagent 工具不存在，该窗口内的模型请求只是缺少它。这是诚实的状态——替代方案是一个描述或执行都不可信的已注册工具。
- 严格性意味着 persona 可能在渲染时导致轮次失败（例如在无 cwd 的会话上使用 `{{cwd}}`）。失败是受控的——该轮次以 `error` 结束，循环存活——而且这是一个我们希望大声暴露的撰写错误。
- 目前没有在 prompt 行文中转义字面 `{{name}}` 的语法；如果真实 prompt 确实需要，届时再添加。
