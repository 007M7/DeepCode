# @deepseek-ai/dsh-subprocess-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-subprocess`](../subprocess/README.md) seam 的本地实现。`LocalSubprocessService` 拥有私有运行时目录，解析本地可执行文件，以显式 stdio spawn 普通 detached 进程树，并通过 `node-pty` 与平台进程检查实现终端进程。该实现没有任何配置：每项处置方式、限制、终端尺寸、宽限期与目录都来自调用方 seam（[`dsh-bash-local`](../../bash/bash-local/README.md)、[`dsh-lsp-local`](../../lsp/lsp-local/README.md)、[`dsh-pty-local`](../../pty/pty-local/README.md)和 [`dsh-code-runtime-subprocess`](../../code-runtime/code-runtime-subprocess/README.md)）。

## 行为（以及设计来源）

- **带平台正确信号发送的 detached 进程树**：POSIX 子进程使用 `detached` spawn（拥有独立进程组），信号以负 pgid 发送并以直接子进程作为回退；Windows 通过 `taskkill /PID <pid> /T /F` 终止进程树（可为测试注入）。`terminate()`（句柄唯一的终止动词）先发送 SIGTERM，经过 spec 的宽限期后再发送 SIGKILL（沿用 OpenCode 的升级策略；管道与子 shell 会随父进程一起结束），进程树消亡后为空操作；`waitForExit()` 轮询整棵进程树的存活状态，使消费方的拆卸能确认真正的完全停稳。组长进程退出后，仍然打开的管道也只获得同样有界的排空宽限期，因此存活的后代进程无法无限期地拖住结果不结算。系统会容忍 ESRCH；脱离该组重新挂载的 daemon 仍可能存活，这与调研工具的局限相同。
- **按流划分的处置方式**：`'pipe'` 把原始流原样交给调用方（协议分帧仍归消费方所有）；`'inherit'` 直通父进程的描述符；收集模式（collect）在输出超过上限后于内存中保留尾部（错误与结果通常聚集在末尾，沿用 pi/OpenCode 的理由），并在配置了 spill 上限时把完整流追加到一个私有临时文件；省略 `spill` 则只保留尾部，即诊断尾部的形状。某条流大于 spill 上限时，会丢弃已不完整的 spill，仅返回带截断标记的尾部；spill 文件描述符在结算时封存，最终关闭失败时则不公布路径，以免声称存在不完整的文件。spill 文件权限为 `0600`、名称随机，位于按需延迟创建的 `0700` 每进程目录之下。
- **凭据清除 + 显式合并**：以 `process.env` 为基础，移除形似凭据的变量（`*KEY*`／`*SECRET*`／`*TOKEN*`）和所有环境中已有的 `DSH_*` 名称；spec 的显式 `env` 在该清除之后合并且不做命名空间校验，因此有意提供的凭据或当前 `DSH_*` 事实会胜出，而陈旧的嵌套 harness 身份无法从环境中隐式漏入。提供的 stdin 会被写入后关闭；否则 fd 0 指向 `/dev/null`。参见 [stdin/env Agent Note（agent 决策记录）](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md)与[受管环境 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.md)。
- **基于偏移量的读取**：收集模式的读取器以全流字节坐标返回增量；服务自身从不持有游标，因此消费方自有的游标（bash 的后台读取路径）与完整流重读可以共存，结算前后皆然。
- **执行世界坐标**：`cwd` 是宿主进程 cwd，`runtimeRoot` 是所有者私有的临时目录，会在资源释放时删除，并且删除发生在报告任何进程清理失败之前；`resolveExecutable` 检查绝对文件，或使用平台感知的可执行扩展名在清理后的有效 PATH 中查找。
- **终端进程所有权**：`spawnTerminal` 分配 `node-pty`，桥接 UTF-8 终端字节，检查当前前台进程组并向其发送信号，并先于顶层 shell 清理后代。每次前台检查都会保留有根进程树中的精确身份；Linux 还会在会话 leader 退出后枚举该 POSIX 会话。因此，先前观察到的 macOS 后代以及任何同会话 Linux 成员在重新设定父进程后仍受身份围栏保护，而 pid／启动身份可防止清理因 PID 复用而跟随到其他进程。上层 PTY 后端负责提示符就绪检测、缓冲和面向模型的操作。
- **先终止再等待退出的 dispose**：服务保留存活句柄，只为让自身的 dispose 能对每个仍在运行的进程树执行升级并等待其退出；已结算与 spawn 失败的句柄在结算时即离开存活集合。

## 模型体验

通过消费方 seam 间接影响（目前是 `dsh-tool-bash` 背后的 bash 执行器家族）；进程输出与生命周期面向模型的全部渲染归消费方所有。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **Windows 进程树支持仅为尽力而为，且未经 CI 测试**：终止经由 `taskkill /PID <pid> /T /F` 完成，所有结果都被就地吸收，不向外抛出（进程树已不存在、竞态、二进制缺失），存活探测则回退到直接子进程边界；测试套件只通过注入的运行器覆盖这条路由，且 `packages/subprocess/*` 被排除在 Windows 测试矩阵之外。
- **终端进程检查仅支持 Linux／macOS**：检查器没有受支持的平台实现时，终端原语会失败；Linux 精确探针覆盖 x64 与 arm64，macOS 使用 `ps` 快照。
- **守护化的终端后代仍可能逃出可观察边界**：在 macOS 上，子进程若在任何前台检查快照产生前重新设定父进程，便无法再从 `node-pty` 根发现；在 Linux 上，调用 `setsid` 的子进程会同时离开进程树与该提供方拥有的终端会话。本地提供方不会增加持续运行的进程表监视器。
- **凭据清除依赖名称启发式规则**：只匹配 `*KEY*`／`*SECRET*`／`*TOKEN*`；名称不同的 secret（例如 `*PASSWORD*`）会继续传递，对误删变量引入白名单属于已记录的后续工作。
- **不会删除已完成的 spill 文件**：有界的完整输出恢复文件（以及每个进程的私有 spill 目录）会在 OS tmpdir 下累积，直到外部机制进行清理；超大的不完整 spill 会被丢弃并立即尝试删除，但清理失败可能留下一个有界文件。

原始进程处理位于 `src/spawn.ts`；`src/index.ts` 负责服务接线。
