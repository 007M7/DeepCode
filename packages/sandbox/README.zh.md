# sandbox/：进程沙箱能力家族

[English](README.md) | 中文

[能力 seam 拆分](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)中负责限制的一半：抽象提供方接口、平台后端和共享策略归属位置。消费方把即将 spawn 的精确 argv 交给 `ctx.sandbox`，改为 spawn 返回的已包装 argv；完整的 `SandboxExecutionPolicy`（模式 + 工作区根目录）随每次能力调用传递，其中受限制的子集成为提供方的 `SandboxPolicy`。因此，不同会话与消费方可以同时按不同策略施加限制。这些均为**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| `sandbox/` | 抽象进程沙箱 seam（`SandboxProvider` 契约 + 模式／强制执行／策略词汇），加共享 ESCALATION 工具包（`approveEscalation`、权限逐级严格扩大的阶梯、拒绝／提示标记），以及所有强制执行方言共享的 `writableRoots` 派生 | `ctx.sandbox` |
| `sandbox-local/` | 按平台链选择的本地后端：Linux 使用 `bwrap`，否则使用 `landlock-run` launcher（通过 npm 分发的 [`node-addon-landlock-run`](https://www.npmjs.com/package/node-addon-landlock-run) 家族，在自身仓库构建发布）；darwin 使用 `sandbox-exec`／Seatbelt。多候选链会执行功能探测，唯一候选项直接选择，结论缓存，失败时默认拒绝 | （注册 `ctx.sandbox`） |
| `sandbox-policy/` | 策略解析器：部署回退值，加每个会话的持久模式与不可变 cwd 根目录。两个强制执行家族都消费完整的逐调用结果，因此 bash 与 fs 不会限制到不同根目录 | `ctx.sandboxPolicy` |

该 seam 只限制与宿主共享文件系统和内核的子进程。容器、microVM 和远程执行器都不是这里的后端：它们会以环境一致的分组替换整个能力实现（`ctx.bash`、`ctx.fs`）；边界记录在[沙箱 Agent Note](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)中。

当前消费方：[`bash/bash-sandbox`](../bash/bash-sandbox/)（包装 `['bash', '-c', command]` 时会调用 `ctx.sandbox`）和 [`fs/fs-sandbox`](../fs/fs-sandbox/)（进程内路径隔离，而非 argv 包装层；读取 `ctx.sandboxPolicy`，对写入／编辑强制执行共享模式）。跨家族边界是沙箱 Agent Note 的[跨家族 fs 沙箱](../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md)阶段；共享词汇使两个家族可以向模型传授同一种拒绝标记与升权流程。
