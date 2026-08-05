# dsh-agent-presets

[English](README.md) | 中文

按会话组装 agent（智能体）。**preset** 是一个目录，其中放置一份 `agent.cordis.yml`；把它挂载到某个 agent 的 scope 上下文之下，该会话就拥有自己的工具、提示词段落以及其他面向模型的贡献，而其他在运行的会话各自保持不变。

其机制完全来自 Cordis：entry 上下文沿原型链连到子树被挂载时所在的上下文，而 [`dsh-tools`](../../core/tools/README.md) 与 [`dsh-system-prompt`](../../core/system-prompt/README.md) 本就按调用方上下文的 scope 分层归档注册。因此把一份组装挂到 `agent.ctx` 之下，它就只属于该 agent，并随 agent 一起卸载，无需在这些注册表中新增任何分层。

## 服务：`AgentPresets`（ctx 键：`agentPresets`）

发现过程不做缓存：`list()` 与 `resolve()` 每次调用都重新读取各个根目录，因此进程运行期间新写的 preset 立即可见，被删除的 preset 也会在下一次读取时消失。

- `ctx.agentPresets.defaultId: string` 调用方未指定时挂载的 preset id。
- `ctx.agentPresets.list(): Promise<AgentPreset[]>` 当前各根目录提供的全部 preset；id 重复时靠前的根目录胜出。
- `ctx.agentPresets.resolve(id?): Promise<AgentPreset>` 按 id 取一个 preset，缺省取 `defaultId`。没有任何根目录提供该 id 时抛错，并列出可用 id。
- `ctx.agentPresets.mount(agentCtx, id?): Promise<AgentPreset>` 用一个 preset 组装一个 agent，并返回所挂载的 preset 供调用方记录。

`AgentPreset` 携带 `id`（目录名）、`trust`（`system` 或 `user`，取自它所在的根目录）以及 `path`（组装文件的绝对路径）。

### 应在何处调用 `mount()`

agent 工厂的 `setup(agentCtx)` 钩子是唯一受支持的调用点。只有在那里，组装是在 agent 尚未发布时装入的，因此挂载被拒绝会让整次创建回滚，而不会留下一个组装到一半的会话。子树归 `agentCtx` 的 fiber 所有，随 agent 一起卸载，调用方无需持有 disposer。

### 会话实际运行的是哪个 preset

创建头部记录的是会话**以什么开始**，`resolveSessionPreset(session)` 给出的才是它**实际运行的**。空白会话一旦切换过，两者就不同，因此所有重建路径——选择器读取的摘要、resume、fork——都走解析，而非直接读头部。

头部保持冻结，因为它是创建期事实。切换以 `agent-preset/selected` 会话事件记录，在替换提交之后追加；这正是 model-visible ⟺ logged 规则的要求：preset 决定模型看到的工具 schema 与提示词段落，因此必须能从日志重建。只读头部会让切换过的会话按创建时的组装重建，从而重放新工具集无法执行的历史——这正是「仅空白可切」那道锁要防的危险。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `default` | 必填 | 调用方未指定时挂载的 preset id |
| `roots` | `[]` | 按优先级排列的扫描目录；每项提供 `path`（开头的 `~` 会展开）与 `trust`（默认为 `user`） |

根目录不存在时视为不提供任何 preset，而非失败：用户根目录在写出第一个本地 preset 之前并不存在，而指定了没有任何根目录提供的默认值，在解析时本就会明确报错。

### 默认 preset 是一项用户设置

当组装中存在 settings 提供方时，本插件会注册 `agent-presets` 命名空间，并以 `config.default` 作为其组装 base，因此用户文档会层叠覆盖部署方的工程默认值：

```yaml
agent-presets:
  default: core-web
```

该值在每次解析时读取而非快照，因此热重载的文档对**此后创建**的会话生效，而每个运行中的会话仍停留在它当初据以组装的 preset 上。清空用户字段即重新继承组装默认值。若默认值指向没有任何根目录提供的 preset，写入时不会报错，而在下一次 `resolve()` 时失败——名单是一个活动目录，此刻不存在的名字，等到某个会话真正索取时可能已经存在。

## 挂载会拒绝什么

直接挂载的子树不会出现在 `ctx.loader.entries()` 中，因此没有任何启动审计能覆盖它。`mount()` 因此自行校验结果可用，并拒绝三种情况。

**目标上下文没有 scope。** 挂载到不带 agent scope 的上下文，会把该 preset 的工具注册成全局的，作用于进程内每一个 agent。

**某一行始终未进入可用状态。** 模块导入失败或插件抛错的行，loader 已经会拒绝；剩下的情况是某一行仍在等待该组装从未提供的服务，审计会指名这种情况。

**某一行把服务发布进了根 realm。** 这类服务是进程级全局而非按会话的，因此第二个挂载同一 preset 的会话会与第一个相撞。确实需要自带服务的 preset，应把它放在 `isolate` realm 之后——用 entry 本地 realm 得到该会话私有的实例，或用共享 label 让多个会话共用一个——否则该服务应改放进宿主组装。

最后一条规则由本包的运行时不变量在每次服务通知时复查，因为从定时器或异步续体中发布的行会绕过一次性审计。

## preset 文件是输入，不是持久化目标

只要 Loader 认为配置变了，它就会把树写回源文件——而一个行释放自己的 fiber 就足以让它这么认为：该 entry 被标记 `disabled`，随即触发写回。若继承该行为，一个会话的运行时状态就会被烧进所有会话共享的文件里：YAML 往返会抹掉注释，而对随附的只读 preset，`writeFile` 还会在 `setTimeout` 内抛出无人接管的 rejection。

因此被挂载的子树把 `write()` 覆写为空操作。本包不写任何组装；创作组装是另一件独立且显式的操作。

## 信任

preset 就是组装，因此一个 preset 的权限恰好等于它所引用的插件。`user` preset——无论由人还是由 agent 写出——与 shell 访问权限同级；`trust` 字段的存在是为了让消费方呈现这一差异，而不是用来强制隔离。

## Model Experience

Indirectly, through the plugins a mounted composition registers, which own every tool schema and prompt section the preset makes visible to its one agent.

#### KV Cache effect

在一个 agent 的整个生命周期内保持前缀稳定：组装只装入一次，发生在 agent 发布之前、因而也在它的首个请求之前，且在 agent 运行期间不再重新读取。为新会话选择不同的 preset，只会为该会话建立不同的前缀，无法让任何已在运行的会话失去缓存复用。

## Known Limitations and Deferred Work

- **无法在存活的 agent 上更换 preset** —— 挂载只在创建时发生一次，因此切换运行中会话的组装意味着要在轮次进行途中卸载其子树，抽走模型可能已经调用的工具。更改默认值只影响此后创建的会话。
- **展示名称就是目录 id** —— preset 不携带 manifest，因此选择器与设置界面在有消费方需要更丰富的元数据之前，只显示 id。
- **根目录扫描不做监听** —— 每次读取都实际访问文件系统，这让名单保持新鲜，但每次 `list()` 会对每个根目录产生一次 `readdir`。
