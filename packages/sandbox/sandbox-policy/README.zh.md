# dsh-sandbox-policy：沙箱策略归属位置（`ctx.sandboxPolicy`）

[English](README.md) | 中文

沙箱策略解析的唯一归属位置：部署默认 [`SandboxMode`](../sandbox/README.md) 与回退根目录，加上每个会话的持久模式覆盖和不可变工作区根目录。每个强制执行策略的能力家族在每次调用时都会收到一项解析完成的模式与根目录策略，模型也会在每次请求前收到同一项有效策略。

## 为何需要共享归属位置

两个家族强制执行同一套模式词汇：沙箱化 bash 执行器（`@deepseek-ai/dsh-bash-sandbox`）与沙箱化文件系统提供方（`@deepseek-ai/dsh-fs-sandbox`）。如果两者各自解析 `mode` + `workspaceRoot`，就可能漂移成分裂世界：bash 限制在一个根目录，fs 却隔离另一个根目录，正是[沙箱 RFC](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)所警告的情况。两个工具层都通过 `ctx.sandboxPolicy` 解析策略，两个强制执行后端也都消费完整的逐调用结果。[跨家族 fs 沙箱 RFC](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md)记录了共享策略决策。

## 配置

- `mode`：部署默认 `SandboxMode`（`read-only`／`workspace-write`／`danger-full-access`），加载时验证。默认为 `read-only`（故障安全）。
- `workspaceRoot`：无 agent（智能体）的调用或没有 cwd 的会话在 `workspace-write` 下可写入的回退目录。默认为 `process.cwd()`；无论显式配置还是采用默认值，都会解析为其绝对文件系统标识。普通 agent 调用改用其会话头中不可变的 `cwd`。

## 接口

- `ctx.sandboxPolicy.resolve({ session?, mode? })`：解析一项完整的逐调用策略。显式批准的模式优先于会话最后一条 `sandbox/mode` 事件，后者又优先于 `defaultMode`；会话不可变的 `cwd` 会先按文件系统语义规范化，再成为 `workspaceRoot`，否则使用配置的回退值。规范化先于词法归一化，因此 `symlink/..` 与进程工作目录解析保持一致。
- `ctx.sandboxPolicy.defaultMode`／`ctx.sandboxPolicy.workspaceRoot`：`resolve()` 使用的部署默认值与回退根目录。
- `sandbox:policy`：由 `resolve({ session })` 派生的请求时系统提示词段落。它说明当前文件操作模式及其后果，并列出 `workspace-write` 下所有规范化的可写根目录；不会声称主机权限、沙箱后端就绪状态或网络／进程限制。
- `effectiveSandboxMode(events)`：会话 `sandbox/mode` 事件的纯 fold（最后一次切换胜出，没有则为 `undefined`），在 `resolve()` 内使用。
- `setSandboxMode(session, mode)`：逐会话覆盖的唯一写入路径：恰好追加一条 `sandbox/mode` 事件。切换本身就是事件；不会在带外修改模式。
- `SANDBOX_MODES`：所有模式，用于选项展示与运行时验证。

可选的 `./invariant` 配套组件会拒绝伪造的持久 `sandbox/mode` 事件，只要其值不在该封闭词汇中；Session 与其配套组件负责相关存储与核心执行封闭规则。渲染后的段落记录在 `request/header` 中，因此无需另一条事件或内存中的「上次告知」镜像，也能重建确切的有效策略。

## 逐会话存储

运行时切换是在对应会话日志中追加的一条 `sandbox/mode` 事件。`effective = explicit grant ?? fold(events) ?? deployment default`，因此覆盖会通过回放跨重启保留，两个会话也绝不会看到彼此状态。工作区标识无需另一条事件：创建时记录的不可变 `SessionHeader.cwd` 是该会话每次调用使用的根。该事件仍只进入日志；下一次请求会在任何工具调用发生前，根据 fold 组装当前段落。

## 模型体验

### 当前文件沙箱策略

#### 模型看到的内容

每次 agent 请求都有一个 `sandbox:policy` 系统段落。该段落只说明 DSH 文件操作策略；工具 schema 仍由各自归属方管理，批准策略仍由 `dsh-user-approval` 的段落管理，计划引导仍由 `dsh-plan-mode` 的段落管理。

##### 只读

```markdown
Current DSH file sandbox policy: read-only. Ordinary file writes, edits, and file-mutating shell effects are denied; required sinks such as `/dev/null` may remain writable. Host OS permissions and sandbox-backend availability may restrict operations further. This policy does not govern network or process access.
```

##### 工作区写入

```markdown
Current DSH file sandbox policy: workspace-write. File writes, edits, and file-mutating shell effects are limited to these canonical writable roots: "<workspace root>", "<temporary root>". Host OS permissions and sandbox-backend availability may restrict operations further. This policy does not govern network or process access.
```

##### 完全访问

```markdown
Current DSH file sandbox policy: danger-full-access. The DSH file sandbox does not restrict file operations. Host OS permissions and other policies still apply. This policy does not govern network or process access.
```

#### Token 影响

每个请求增加一个简洁的系统段落。`workspace-write` 还会列出规范化的会话工作区根目录，以及规范化的 `/tmp` 与平台临时根目录；如果它们指向同一目录则去重。

#### KV Cache 影响

只要会话模式与不可变工作区根目录不变，请求前缀就在字节层面保持稳定。模式切换会在下一次请求中改变该段落；生成的 `request/header` 会记录新的前缀。

## 已知限制与暂缓事项

- **每个会话只有一个主要工作区根目录**：策略解析 `SessionHeader.cwd`；额外可写根目录不属于 `SandboxExecutionPolicy`。
- **仅限文件操作模式**：`SandboxMode` 管控文件操作；网络和进程策略不在其词汇中，因此这里没有限制它们的旋钮。
