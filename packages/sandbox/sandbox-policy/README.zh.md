# dsh-sandbox-policy：沙箱策略归属位置（`ctx.sandboxPolicy`）

[English](README.md) | 中文

沙箱策略解析的唯一归属位置：部署默认 [`SandboxMode`](../sandbox/README.md) 与回退根目录，加上每个会话的持久模式覆盖和不可变工作区根目录。每个强制执行家族在每次调用时都会收到一项解析完成的模式与根目录策略，并登记当前运行时对文件系统工具、一次性 bash 命令和终端会话中的哪些家族施加围栏；模型在每次请求前只会收到这些当前事实。

## 为何需要共享归属位置

文件系统工具、一次性 bash 命令和终端会话可以用不同组合强制执行同一套模式词汇。如果各自解析 `mode` + `workspaceRoot`，就可能漂移成分裂世界，正是[沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)所警告的情况。每个强制执行后端都会消费归属方解析出的完整策略，并贡献其面向模型的家族；因此，当前段落不会声称不受围栏约束的家族也受另一家族的限制。[跨家族 fs 沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md)记录了共享策略决策。

## 配置

- `mode`：部署默认 `SandboxMode`（`read-only`／`workspace-write`／`danger-full-access`），加载时验证。默认为 `read-only`（故障安全）。
- `workspaceRoot`：无 agent（智能体）的调用或没有 cwd 的会话在 `workspace-write` 下可写入的回退目录。默认为 `process.cwd()`；无论显式配置还是采用默认值，都会解析为其绝对文件系统标识。普通 agent 调用改用其会话头中不可变的 `cwd`。

## 接口

- `ctx.sandboxPolicy.resolve({ session?, mode? })`：解析一项完整的逐调用策略。显式批准的模式优先于会话最后一条 `sandbox/mode` 事件，后者又优先于 `defaultMode`；会话不可变的 `cwd` 会先按文件系统语义规范化，再成为 `workspaceRoot`，否则使用配置的回退值。规范化先于词法归一化，因此 `symlink/..` 与进程工作目录解析保持一致。
- `ctx.sandboxPolicy.defaultMode`／`ctx.sandboxPolicy.workspaceRoot`：`resolve()` 使用的部署默认值与回退根目录。
- `ctx.sandboxPolicy.registerEnforcedFamily(family)`：独立注册 `filesystem`、`bash` 或 `terminal`，并返回对应的精确 effect disposer。相同家族仍是彼此独立的贡献；该段落使用规范的家族顺序，并且只有最后一项贡献离开后才移除对应家族。
- `sandbox:policy`：由 `resolve({ session })` 和当前家族贡献派生的请求时系统提示词段落。没有强制执行家族时为空，只说明模式、受影响的面向模型操作，以及 `workspace-write` 下规范化的会话工作区。
- `effectiveSandboxMode(events)`：会话 `sandbox/mode` 事件的纯 fold（最后一次切换胜出，没有则为 `undefined`），在 `resolve()` 内使用。
- `setSandboxMode(session, mode)`：逐会话覆盖的唯一写入路径：恰好追加一条 `sandbox/mode` 事件。切换本身就是事件；不会在带外修改模式。
- `SANDBOX_MODES`：所有模式，用于选项展示与运行时验证。

可选的 `./invariant` 配套组件会拒绝伪造的持久 `sandbox/mode` 事件，只要其值不在该封闭词汇中；Session 与其配套组件负责相关存储与核心执行封闭规则。渲染后的段落记录在 `request/header` 中，因此无需另一条事件或内存中的「上次告知」镜像，也能重建确切的有效策略。

## 逐会话存储

运行时切换是在对应会话日志中追加的一条 `sandbox/mode` 事件。`effective = explicit grant ?? fold(events) ?? deployment default`，因此覆盖会通过回放跨重启保留，两个会话也绝不会看到彼此状态。工作区标识无需另一条事件：创建时记录的不可变 `SessionHeader.cwd` 是该会话每次调用使用的根。该事件仍只进入日志；下一次请求会在任何工具调用发生前，根据 fold 组装当前段落。

## 模型体验

### 当前文件沙箱策略

#### 模型看到的内容

只要至少注册了一个强制执行家族，每次 agent 请求就会有一个 `sandbox:policy` 系统段落。以下示例展示全部三个家族；缺失的家族会被省略。工具插件继续负责操作与升级引导，批准策略仍由 `dsh-user-approval` 的段落管理，计划引导仍由 `dsh-plan-mode` 的段落管理。

##### 只读

```markdown
Current DSH file policy: read-only. The write and edit tools, one-shot bash commands, and terminal sessions cannot modify files under this policy.
```

##### 工作区写入

```markdown
Current DSH file policy: workspace-write. The write and edit tools, one-shot bash commands, and terminal sessions may modify files under the session workspace: "<workspace root>". Some platform temporary areas may also be writable.
```

##### 完全访问

```markdown
Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict the write and edit tools, one-shot bash commands, or terminal sessions.
```

#### Token 影响

每个请求增加一个简洁的系统段落。`workspace-write` 只携带规范化的会话工作区路径；平台特定的临时路径会以摘要表述，不会加入依赖主机的字节。

#### KV Cache 影响

只要会话模式与不可变工作区根目录不变，请求前缀就在字节层面保持稳定。模式切换会在下一次请求中改变该段落；生成的 `request/header` 会记录新的前缀。

## 已知限制与暂缓事项

- **每个会话只有一个主要工作区根目录**：策略解析 `SessionHeader.cwd`；额外可写根目录不属于 `SandboxExecutionPolicy`。
- **仅限文件操作模式**：`SandboxMode` 管控文件操作；网络和进程策略不在其词汇中，因此这里没有限制它们的旋钮。
- **有意概述临时区域**：强制执行后端会授予不同的平台临时区域，这些区域在策略解析后才会选定，因此无法在常驻段落中如实枚举。
