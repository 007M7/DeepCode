# dsh-sandbox-policy：沙箱策略归属位置（`ctx.sandboxPolicy`）

[English](README.md) | 中文

沙箱策略解析的唯一归属位置：部署默认 [`SandboxMode`](../sandbox/README.md) 与回退根目录，加上每个会话的持久模式覆盖和不可变工作区根目录。每个强制执行策略的能力家族在每次调用时都会收到一项解析完成的模式与根目录策略。

## 为何需要共享归属位置

两个家族强制执行同一套模式词汇：沙箱化 bash 执行器（`@deepseek-ai/dsh-bash-sandbox`）与沙箱化文件系统提供方（`@deepseek-ai/dsh-fs-sandbox`）。如果两者各自解析 `mode` + `workspaceRoot`，就可能漂移成分裂世界：bash 限制在一个根目录，fs 却隔离另一个根目录，正是[沙箱 RFC](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)所警告的情况。两个工具层都通过 `ctx.sandboxPolicy` 解析策略，两个强制执行后端也都消费完整的逐调用结果。[跨家族 fs 沙箱 RFC](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md)记录了共享策略决策。

## 配置

- `mode`：部署默认 `SandboxMode`（`read-only`／`workspace-write`／`danger-full-access`），加载时验证。默认为 `read-only`（故障安全）。
- `workspaceRoot`：无 agent（智能体）的调用或没有 cwd 的会话在 `workspace-write` 下可写入的回退目录。默认为 `process.cwd()`；无论显式配置还是采用默认值，都会解析为其绝对文件系统标识。普通 agent 调用改用其会话头中不可变的 `cwd`。

## 读取拒绝

`readDenyPaths` 列出**受约束**执行绝不可读取的绝对路径，无论其模式在其他方面允许什么。省略（或为空）时拒绝 harness 凭据文档 `$DSH_HOME/.env`；非空列表则替换该默认值。拒绝项有意点名确切路径而非根目录：拒绝整个 harness home 会连带拿走模型对自己会话日志的既定访问。

强制执行的形态由后端决定。Seatbelt 追加一条尾部 `deny file-read* file-write*`（最后匹配的规则胜出），bwrap 在任何工作区绑定之后把 `/dev/null` 映射到每个路径上；Landlock 的授权是纯粹的允许列表，`/` 上的读授权无法被扣除，因此 `confine()` 把强制执行报为 `partial`，而不是假装该边界存在。`danger-full-access` 根本不做任何约束，那里也就没有任何拒绝适用——凭据文档届时只受自身文件权限模式保护，而这挡不住同 UID 的工具进程。

## 接口

- `ctx.sandboxPolicy.resolve({ session?, mode? })`：解析一项完整的逐调用策略。显式批准的模式优先于会话最后一条 `sandbox/mode` 事件，后者又优先于 `defaultMode`；会话不可变的 `cwd` 会先按文件系统语义规范化，再成为 `workspaceRoot`，否则使用配置的回退值。规范化先于词法归一化，因此 `symlink/..` 与进程工作目录解析保持一致。
- `ctx.sandboxPolicy.defaultMode`／`ctx.sandboxPolicy.workspaceRoot`：`resolve()` 使用的部署默认值与回退根目录。
- `effectiveSandboxMode(events)`：会话 `sandbox/mode` 事件的纯 fold（最后一次切换胜出，没有则为 `undefined`），在 `resolve()` 内使用。
- `setSandboxMode(session, mode)`：逐会话覆盖的唯一写入路径：恰好追加一条 `sandbox/mode` 事件。切换本身就是事件；不会在带外修改模式。
- `SANDBOX_MODES`：所有模式，用于选项展示与运行时验证。

可选的 `./invariant` 配套组件会拒绝伪造的持久 `sandbox/mode` 事件，只要其值不在该封闭词汇中；Session 与其配套组件负责相关存储与核心执行封闭规则。

## 逐会话存储

运行时切换是在对应会话日志中追加的一条 `sandbox/mode` 事件。`effective = explicit grant ?? fold(events) ?? deployment default`，因此覆盖会通过回放跨重启保留，两个会话也绝不会看到彼此状态。工作区标识无需另一条事件：创建时记录的不可变 `SessionHeader.cwd` 是该会话每次调用使用的根。该事件只进入日志（沿用 `approval/*` 先例）：模型通过强制执行工具的拒绝标记获知模式，绝不会从事件获知。

## 模型体验

通过 `dsh-tool-bash` 和 `dsh-tool-fs` 间接影响；它们会在 `[sandbox: …]` 拒绝标记和升权提示词中渲染该服务持有的有效模式，`sandbox/mode` 事件本身绝不会到达模型。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀变更由上述消费方负责，且提示词有意不包含模式。

## 已知限制与暂缓事项

- **每个会话只有一个主要工作区根目录**：策略解析 `SessionHeader.cwd`；额外可写根目录不属于 `SandboxExecutionPolicy`。
- **仅限文件操作模式**：`SandboxMode` 管控文件操作；网络和进程策略不在其词汇中，因此这里没有限制它们的旋钮。
