# @deepseek-ai/dsh-bash-local

[English](README.md) | 中文

`@deepseek-ai/dsh-bash` 执行器 seam 的本地子进程实现：`LocalBashExecutor` 每次调用都会在独立进程组中 spawn `bash -c <command>`，收集有界输出，并用限制大小的完整流 spill 文件保留超量内容，随后针对整个进程组从 SIGTERM 逐步升级为 SIGKILL。

包根目录导出默认与具名的 `LocalBashExecutor` 插件及其 `Config`；子进程管道细节保留在该实现包内部。

## 配置

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace   # default: process.cwd()
    timeoutMs: 120000          # default foreground timeout
    maxTimeoutMs: 600000       # cap for per-call overrides
    maxOutputBytes: 64000      # per-stream in-memory cap; overflow spills to disk
    maxSpillBytes: 67108864    # per-stream full-output spill cap
    graceMs: 3000              # kill escalation and post-exit pipe-drain grace
```

## 行为（以及设计来源）

设计时调研了 Claude Code、OpenCode、Codex 和 pi 的 bash 工具，主要取舍如下：

- **每次调用都 spawn，不保留 shell 状态**：每次调用都启动新的非登录 `bash -c`（行为确定，不读取 rc 文件）。调研的四种工具均会每次调用单独 spawn。`XXX(stateful-shell)` 位于 `src/run.ts`，记录了两种已验证的有状态设计（Claude Code 仅持久化 cwd；Codex 使用 PTY exec 会话），供真实工作流程需要时采用。
- **使用逐步升级终止整个进程组**：子进程使用 `detached` spawn（拥有独立进程组）；终止时先向该组发送 SIGTERM，经过 `graceMs` 宽限期后再发送 SIGKILL（默认 3 秒，沿用 OpenCode 的升级策略；管道与子 shell 会随父进程一起结束）。主 shell 退出后，继承的 stdout/stderr 管道也只获得同样有界的排空宽限期，因此存活的后代进程无法无限期地阻止命令结束。系统会容忍 ESRCH；脱离该组重新挂载的 daemon 仍可能存活，这与调研工具的局限相同。
- **保留尾部的截断 + 有界 spill 文件**：输出超过 `maxOutputBytes` 后，内存中保留尾部（错误／结果通常聚集在末尾，沿用 pi/OpenCode 的理由），同时将完整流追加到临时文件，并在可用时报告该路径。前台 `BashExecRequest.stdoutMaxBytes` 可为某个受信任调用方提高单次 stdout 捕获预算；stderr 和后台任务仍使用 `maxOutputBytes`。某个流大于 `maxSpillBytes` 时，会丢弃已不完整的 spill，仅返回带截断标记的尾部。如果最终关闭 spill 时报告延迟写回失败，执行器同样不会公布路径，以免声称存在不完整的文件。
- **适合模型的环境变量 + 凭证清理**：以 `process.env` 为基础，移除形似凭证的变量（`*KEY*`／`*SECRET*`／`*TOKEN*`）和所有环境中的 `DSH_*` 名称，再设置 `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat`（Codex 硬编码的集合），防止分页器与 ANSI 颜色破坏结果。spec 的普通 `env` 在清理后合并，但会拒绝 `DSH_*`；受管 `dshEnv` 会拒绝普通名称并最后合并，防止遗留嵌套 harness 身份。提供的 stdin 会被写入后关闭；否则 fd 0 指向 `/dev/null`。详见 [stdin/env Agent Note](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md) 与 [受管环境 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.md)。
- **后台进程**：`start()` 会立即返回实时 `BashProcess` 句柄，不应用超时（Claude Code 在转为后台时会解除超时）；句柄的 `readOutput()` 使用全流字节偏移量进行增量读取；dispose 会终止每个运行中的进程并等待其退出。所有具有任务形态的事项（id、所有权、轮询、通知）都属于通用 [`ctx.tasks` 运行时](../../tasks/tasks/README.md)，工具层会在其中注册该句柄；本执行器不会接触会话或注册表。

## 模型体验

通过 `dsh-tool-bash` 间接影响；该工具会渲染此执行器有界的 stdout/stderr 尾部、后台进程增量、spill 文件路径与基础设施失败。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **自身不受约束**：此执行器始终以 harness 进程的权限运行命令；需要限制的部署可以组合 [`dsh-bash-sandbox`](../bash-sandbox/README.md)，每次调用的 allow/deny/ask 策略则属于 `tools/pre-execute`。
- **没有持久 shell 或 PTY**：每次调用都启动新的非登录 `bash -c`；仅持久化 cwd 与交互式终端会话均继续暂缓，直到真实工作流程需要它们。
- **仅支持 POSIX**：`bash` 二进制、独立进程组、进程组终止以及 SIGTERM→SIGKILL 升级都已硬编码；不支持 Windows。
- **凭证清理依赖名称启发式规则**：只匹配 `*KEY*`／`*SECRET*`／`*TOKEN*`；名称不同的 secret（例如 `*PASSWORD*`）会继续传递，对误删变量引入白名单属于已记录的后续工作。
- **不会删除已完成的 spill 文件**：有界的完整输出恢复文件（以及每个进程的私有 spill 目录）会在 OS tmpdir 下累积，直到外部机制进行清理；超大的不完整 spill 会被丢弃并立即尝试删除，但清理失败可能留下一个有界文件。

原始进程处理位于 `src/run.ts`；`src/index.ts` 负责服务接线。
