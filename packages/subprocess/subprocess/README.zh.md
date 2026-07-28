# @deepseek-ai/dsh-subprocess

[English](README.md) | 中文

进程管理器 seam（`ctx.subprocess`）是同一执行世界中的进程侧。抽象的 `SubprocessService` 公开其规范化 `cwd`、私有 `runtimeRoot`、可执行文件查找、普通受管 `spawn` 和一项终端进程原语；其词汇涵盖原始／收集式 stdio、进程与终端句柄、退出事实、进程树／会话清理，以及受管的 `DSH_*` 环境命名空间。本地实现位于 [`dsh-subprocess-local`](../subprocess-local/README.md)。

## 契约

- `spawn(spec)` 立即返回一个实时句柄；`done` 在进程关闭时以退出事实 resolve（`SubprocessOutcome` 不携带输出，也不携带原因分类），仅在 spawn 层面失败时 reject。
- `cwd` 与 `runtimeRoot` 是提供方执行世界中的绝对路径。消费方在 `runtimeRoot` 下物化私有辅助程序，绝不使用仅宿主可见的临时目录。`resolveExecutable(command, env?, signal?)` 验证绝对命令，或根据该执行世界清理后的 PATH 加显式覆盖来解析裸名称。
- spec 完全显式（argv、cwd、按流划分的 stdio 处置方式（disposition）、宽限期），因为随部署变化的默认值属于调用方 seam 的配置，而不属于某个隐藏的进程管理器默认值（`dsh-bash` 的 request/spec 拆分是这条规则的所属模板）。`argv` 绝不经过 shell 解释；需要 shell 的消费方自行传入 `['bash', '-c', command]`。
- stdio 按流采用 Node 形状：`'pipe'` 把原始流交给调用方做自己的协议分帧（LSP 的 JSON-RPC、ACP（Agent Client Protocol）的 ndjson），`'inherit'` 直通父进程描述符以承载诊断输出，收集模式（collect）`{ maxBytes, spill? }` 则缓冲一段有界尾部，外加可选的完整流 spill 文件。收集模式的读取器接受全流字节偏移量且从不消费，因此独立的读取器不会抢走彼此的增量；偏移量滑出内存尾部窗口的读取标记为 `lossy`，并在 spill 文件存在时指向它。收集到的输出在结算后仍可读取。
- 终止在每个平台上都以进程树为范围（POSIX 用 detached 进程组并以直接子进程回退；Windows 用 `taskkill /T`）：`terminate()`（唯一的终止动词）执行 SIGTERM→宽限期→SIGKILL 升级（幂等，也由 spec 的 abort 信号驱动，进程树消亡后为空操作）；`waitForExit(signal?)` 观察整棵进程树的存活状态，使消费方自有的拆卸阶梯能在真正完全停稳后才进入下一层。管理器只响应中止，但绝不判定原因（deadline、拆卸阶梯与原因分类归调用方所有）。
- `spawnTerminal(spec)` 是唯一的非管道原语。其句柄负责真实 PTY、有效 UTF-8 字节 I/O、前台进程组检查／信号发送、TERM→KILL 全会话清理，以及等待完全停稳。顶层进程退出后，输出流会在排完队列中的输出后结束；存活期间的传输故障会拒绝 `done`。这些操作仍属于一项基底原语，因为普通管道无法分配控制终端，也无法证明并清理完整的终端会话；就绪检测、scrollback 与所有者策略仍归 PTY 消费方所有。
- `SubprocessTerminalLifecycle` 把句柄的顶层 `done` promise 与由提供方负责的会话清理组合起来。它绑定生命周期取消，共享同一个进行中的清理尝试，允许失败的尝试重试，规范化清理拒绝，并在不了解提供方进程机制的情况下对完全停稳观测施加上限。
- `scrubbedParentEnv()` / `SENSITIVE_ENV_PATTERN` 是唯一一份共享的凭据清除定义：环境中形似凭据的名称与 `DSH_*` 名称都会被丢弃，显式 `env` 在清除之后合并。本地普通 spawn 与终端 spawn 都应用这一定义；自行拥有 spawn 的 SDK 管理传输层可以直接导入它。
- 服务自身的 dispose（资源释放）会终止所有仍在运行的受管进程并等待其退出。

参见[进程管理器数据结构目录](../../../docs/core-data-structures/subprocess.md)与 [seam Agent Note（agent 决策记录）](../../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md)。

## 模型体验

通过消费方 seam 间接影响（目前是 `dsh-tool-bash` 背后的 bash 执行器家族）；进程输出与生命周期面向模型的全部渲染归消费方所有。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **由 SDK 管理的 spawn 仍在服务之外**：自行拥有内部 spawn 的 SDK 传输层无法经该服务路由这次调用；它仍可导入 `scrubbedParentEnv`，使环境策略保持单一来源。
- **拆卸阶梯归消费方所有**：该 seam 只提供信号动词与进程树存活等待，不提供现成的停稳序列；每个进程外消费方自行编码其子进程的配合形状（ACP 后端以 stdin EOF 打头的阶梯是仓库内模板）。
