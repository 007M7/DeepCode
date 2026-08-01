# @deepseek-ai/dsh-pwsh-local

[English](README.md) | 中文

`@deepseek-ai/dsh-bash` 执行器 seam 的本地 PowerShell 实现，基于 [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) 服务：`PwshLocalExecutor` 每次调用以受管进程的方式通过 `ctx.subprocess` spawn `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>`，并拥有所有 PowerShell 形状的职责——可执行文件解析、命令默认化与上限、超时/取消分类、面向模型的终端环境，以及后台读取的 stdout/stderr 合并。进程组机制（有界 spill 输出、凭据清理、终止升级、销毁）属于 subprocess 服务。

命令字符串作为 ONE argv 元素传给 `-Command`：由 PowerShell 自己解析文本，不存在中间 shell，因此没有需要转义的 shell 引号层（`bash -c` 字符串域在这里没有对应物）。原生 Win32 路径（`C:\...`）原样通过。

包根导出默认与具名 `PwshLocalExecutor` 插件、其 `Config`，以及纯函数 `resolvePwshPath`/`candidatePwshPaths` 辅助函数。

## 配置

```yaml
- id: bash
  name: '@deepseek-ai/dsh-pwsh-local'
  config:
    cwd: C:\path\to\workspace   # default: process.cwd()
    timeoutMs: 120000           # default foreground timeout
    maxTimeoutMs: 600000        # cap for per-call overrides
    maxOutputBytes: 64000       # per-stream in-memory cap; overflow spills to disk
    maxSpillBytes: 67108864     # per-stream full-output spill cap
    graceMs: 3000               # kill escalation and post-exit pipe-drain grace
    pwshPath: C:\Program Files\PowerShell\7\pwsh.exe  # explicit executable; else well-known locations, then PATH
```

## 行为（及其由来）

作为 `dsh-bash-local` 的 Windows 对应物，逐调用地镜像其语义：

- **每次调用新建进程，无 shell 状态**——每次调用都是全新的非交互 `pwsh -Command`（确定性；不加载 profile 文件）。`-NoLogo -NoProfile -NonInteractive` 关闭启动横幅、profile 加载与会干扰工具输出的提示符。
- **可执行文件解析**——`resolvePwshPath` 优先显式 `pwshPath`，然后在 Windows 上依次探测 PowerShell 7 安装位置、每个 PATH 条目（Microsoft Store 安装；剥离两端引号）以及作为遗留兜底的 Windows PowerShell 5.1，逐一检查 `existsSync`；其他平台回退为通过 PATH 解析的裸 `pwsh`。解析是 `(configured, env, platform)` 的纯函数，在构造时执行一次。
- **受管进程组之上的配置预算**——`resolve()` 从配置填充 `workdir`/`timeoutMs`/`stdoutMaxBytes`，每次 spawn 都向服务提供显式字节上限、spill 上限与 `graceMs`。进程树终止（Windows 用 taskkill，POSIX 用进程组信号）、退出后管道排空宽限、保尾截断与有界 spill 文件是 [`dsh-subprocess-local`](../../subprocess/subprocess-local/README.md) 的机制。前台 `BashExecRequest.stdoutMaxBytes` 可为单个受信调用方提高 stdout 捕获预算；stderr 与后台运行仍使用 `maxOutputBytes`。
- **超时与取消分类**——`run()` 通过一个 deadline 融合配置夹取的超时与调用方信号；只有执行器自身超时报告 `timedOut`，上游取消报告 `aborted`，自我终止的命令两者都不报告（见 [timeout 库 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md)）。Windows 将强制终止报告为退出码 1 且无信号，因此基于信号的实情（`signal`、`killed` 状态）在那里仅限 POSIX；超时/取消分类与平台无关。
- **面向模型的终端环境**——`NO_COLOR=1 PAGER=cat GIT_PAGER=cat`（没有 `TERM=dumb`：那是 POSIX 概念；现代 PowerShell 渲染器遵循 `NO_COLOR`），作为普通 env 在服务的凭据清理与 `DSH_*` 通道规则之下合并；显式调用方条目仍然优先。
- **后台进程**——`start()` 立即返回存活的 `BashProcess` 句柄，不设超时；句柄的 `readOutput()` 把服务基于偏移的 stdout/stderr 读取合并为带标记分段的增量与消费游标。仍在运行的进程属于 subprocess 服务，因此它跨执行器重载存活，并随服务销毁（被终止并 join）。一切任务形状的职责（id、所有权、轮询、通知）都在通用 [`ctx.tasks` 运行时](../../tasks/tasks/README.md) 中，由工具层把句柄注册进去——本执行器从不接触会话或注册表。

## 模型体验

间接地，经由 `dsh-tool-pwsh` 呈现本执行器的有界 stdout/stderr 尾部、后台进程增量、spill 文件路径与基础设施失败。

#### KV Cache 影响

无直接失效；具名消费方拥有请求前缀的任何变更。

## 已知局限与延期工作

- **自身不设沙箱**——本执行器始终以 harness 进程的权限运行命令；需要约束的部署应组合沙箱化 bash 执行器或策略。
- **无持久 shell 或 PTY**——每次调用都是全新的 `pwsh -Command`；交互式终端会话在路线图的 pwsh TUI/GUI 渲染工作落地之前保持延期。
- **命令字符串是 PowerShell 文本**——`-Command` 域没有 shell 引号层，但面向模型的命令由 PowerShell 自己解析，因此 PowerShell 语法错误是命令失败，而非启动失败。
- **后台 spawn 失败提示只投递一次**——subprocess 服务不会为从未运行的进程缓冲输出，因此执行器只把 `spawn failed: …` 注入一次 `readOutput()` 增量；丢弃该增量的读取方无法恢复它。
- **Windows 终止不报告信号**——被强制终止的进程以退出码 1、`signal: null` 结束，因此基于信号的状态分类（POSIX `killed`）在 Windows 上不适用；`kill()` 发起的停止仍会直接盖上 `killed`。

清理启发式与 spill 保留的注意事项由 [`dsh-subprocess-local`](../../subprocess/subprocess-local/README.md) 持有，它拥有这些机制。
