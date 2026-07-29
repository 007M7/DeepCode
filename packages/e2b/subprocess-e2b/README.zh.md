# @deepseek-ai/dsh-subprocess-e2b

[English](README.md) | 中文

[`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) seam 的 E2B 实现。它没有配置：先加载 [`@deepseek-ai/dsh-e2b`](../e2b/README.md)，再用本服务取代 `dsh-subprocess-local`。现有的 Bash、PTY、LSP 以及使用 subprocess 的 Code Runtime 消费方随后会在共享远程沙箱中执行，无需 E2B 专用的功能包（package）。

## 行为

- **异步远程启动**：同步 seam 会立即返回一个句柄，同时由 `Sandbox.commands.run(..., { background: true })` 在远程启动进程。包装层发布进程组 ID 并由适配器完成验证之前，`pid` 为 `-1`；stdin 和常规观察会等待该发布，而取消操作可以先停止临时 SDK 句柄。
- **执行世界坐标**：`cwd` 和私有 `runtimeRoot` 来自共享所有者；可执行文件查找会验证绝对路径，或根据沙箱 PATH 加显式覆盖来解析裸名称。
- **Linux 进程组**：带引号保护的包装层会在 `exec setsid --wait` 下启动每组 argv，并在 `ctx.e2b.runtimeRoot/processes` 下记录实际进程组 ID 和私有状态文件。句柄会等待该文件，而不会把 SDK 命令 PID 当作已发布的身份。终止操作以记录的负数 ID 发送 `SIGTERM`，等待调用方的 `graceMs`，再升级到 `SIGKILL` 和 SDK kill 回退；TERM 信号发送或探测失败也会强制触发该升级。失败的事务可通过 `waitForExit()` 观察，并可重试；任何已证明的完全停稳都会永久防止后续终止操作命中复用的 PID。发布前，取消操作使用临时 SDK 句柄；如果发布失败，回滚会终止并验证临时进程组，随后启动操作才会拒绝。发布后，监控失败也会在拒绝前回滚进程组。服务 dispose（资源释放）会拒绝新的启动请求、终止并等待每个保留进程组退出，再等待 SDK 结算和私有清理完成，之后沙箱所有者才会释放。
- **环境边界**：包装层从沙箱命令环境开始，移除环境中的 `DSH_*` 和形似凭据的名称（`*KEY*`、`*SECRET*`、`*TOKEN*`），再把每个有效的 `spec.env` 条目恢复为调用方显式选择；空名称、`=` 和违反 NUL 分帧规则的条目会在启动前被拒绝。宿主环境变量绝不会隐式进入沙箱。私有环境文件在使用后会被删除；命令或终端设置失败时，会先删除其私有状态再拒绝。
- **stdio 投影**：远程包装层先把原始字节分流到可选的有界 spill 文件，再把每个实时分片编码为换行分隔的 base64 ASCII 帧；宿主会跨任意 SDK 回调边界增量恢复字节。pipe 模式把这些字节写入宿主 Node 流；inherit 模式把字节写入 harness 进程流；collect 模式保留有界的宿主尾部，并支持基于偏移量读取。包装层会在等待继承管道的写入方之前发布直接命令状态。对于 collect 或 inherit 输出，超过 `graceMs` 后，适配器会断开未完成的 SDK 流，不公开其中不完整的 spill，并返回该状态，同时保留远程进程组供 `waitForExit()` 和终止操作使用；原始 pipe 则会等待无损传输完成并保留背压。批量 stdin 和流式 stdin 都使用 SDK 句柄。
- **终端会话**：`spawnTerminal()` 使用 E2B 的字节 PTY API，以 mode 为 `0600` 的私有文件传入原样 argv 与清理后的环境，报告前台进程组，发送真实信号，并在结算前清理远程终端会话中的每个进程组。私有随机输出边界会丢弃 E2B 引导 shell 的提示符和回显的 runner 命令，同时保留请求进程的每个字节，包括其第一个提示符。setup 与 teardown 负责私有状态事务，在服务 dispose 期间中止待处理的 setup、阻止发布，并保留未证明已完成的 setup 清理事务，供 dispose 重试。提示符检测、scrollback、就绪状态与所有者策略仍归 `dsh-pty-local` 所有。

基础 E2B 镜像提供该适配器调用的运行时和 Bash/GNU 工具：`node`、`bash`、`setsid`、`ps`、`awk`、`tr`、`env`、`chmod`、`tee`、`head`、`rm` 和 `kill`。自定义模板必须保留兼容的命令和 E2B PTY 支持。

## 模型体验

通过消费方 seam 间接影响模型，例如 `dsh-tool-bash` 背后的 Bash 执行器；这些消费方会渲染远程输出、退出事实、后台增量和 spill 路径。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与延后工作

- **SDK 仍会在宿主内存中保留完整命令输出**：即使本适配器公开的是有界原始字节尾部，E2B `CommandHandle.stdout` 和 `.stderr` 仍会累积 base64 传输内容，因此无法达到进程管理 seam 通常提供的宿主内存边界，而且传输保留量大于源数据流。
- **不支持需要同步 PID 的消费方**：远程启动期间，`pid` 保持为 `-1`；包括 ACP 子进程后端在内，要求立即获得正 PID 的消费方无法原样使用本提供方。
- **重新连接不会重建句柄**：保留沙箱后，远程 PID／状态／spill 文件仍然存在，但新的 harness 进程不会据此重建实时 `SubprocessHandle` 对象或输出游标。
- **保留沙箱时会累积远程状态**：进程目录和有效的 spill 文件会留在 `.dsh-e2b` 下；本 POC 不提供保留清理。
- **E2B 不公开信号事实**：适配器请求的 `SIGTERM` 或 `SIGKILL` 只有在包装层发布的直接退出码没有胜出时才报告为信号；其他未请求的 SDK 退出始终保留为退出码，包括形似 `128 + signal` 的值。
- **无法精确检查终端 stdin 等待状态**：E2B 会公开前台进程组，但不提供证明其正在等待 fd 0 所需的 syscall 证据，因此通用 PTY 后端会回退到受控提示符标记与有界静默机制。
- **依赖 Linux 工具与 E2B 传输语义**：没有 Windows、任意模板、逃逸会话恢复或网络分区的保真层。
