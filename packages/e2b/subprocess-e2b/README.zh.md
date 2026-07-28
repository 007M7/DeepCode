# @deepseek-ai/dsh-subprocess-e2b

[English](README.md) | 中文

[`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) seam 的 E2B 实现。它没有配置：先加载 [`@deepseek-ai/dsh-e2b`](../e2b/README.md)，再用本服务取代 `dsh-subprocess-local`。随后，[`dsh-bash-local`](../../bash/bash-local/README.md) 等现有消费方会在共享远程沙箱中执行，无需 E2B 专用 Bash 适配器。

## 行为

- **异步远程启动**：同步 seam 会立即返回一个句柄，同时由 `Sandbox.commands.run(..., { background: true })` 在远程启动进程。SDK 返回命令 PID 之前，`pid` 为 `-1`；`done`、stdin、终止和 `waitForExit()` 会在内部等待就绪。
- **Linux 进程组**：带引号保护的包装层会在 `setsid --wait` 下启动每组 argv，并在 `ctx.e2b.runtimeRoot/processes` 下记录实际进程组 ID 和私有状态文件。句柄会等待该文件，而不会假设 SDK 命令 PID 就是进程组 ID。终止操作以记录的负数 ID 发送 `SIGTERM`，等待调用方的 `graceMs`，再升级到 `SIGKILL` 和 SDK kill 回退。服务 dispose（资源释放）会在沙箱所有者释放前终止并等待每个保留句柄退出。
- **环境边界**：包装层从沙箱命令环境开始，移除环境中的 `DSH_*` 和形似凭据的名称（`*KEY*`、`*SECRET*`、`*TOKEN*`），再把每个 `spec.env` 条目恢复为调用方显式选择。宿主环境变量绝不会隐式进入沙箱。
- **stdio 投影**：pipe 模式把 E2B 回调转发到宿主 Node 流；inherit 模式把回调转发到 harness 进程流；collect 模式保留有界的宿主尾部，并支持基于偏移量读取。可选的完整 spill 文件写在远程，并且只有未超过其上限时才会对外公布。批量 stdin 和流式 stdin 都使用 SDK 句柄。

基础 E2B 镜像提供该适配器调用的 Bash/GNU 工具：`bash`、`setsid`、`ps`、`tr`、`env`、`chmod`、`tee` 和 `kill`。自定义模板必须保留兼容的命令。

## 模型体验

通过消费方 seam 间接影响模型，例如 `dsh-tool-bash` 背后的 Bash 执行器；这些消费方会渲染远程输出、退出事实、后台增量和 spill 路径。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与延后工作

- **SDK 仍会在宿主内存中保留完整命令输出**：即使本适配器公开的是有界尾部，E2B `CommandHandle.stdout` 和 `.stderr` 仍会持续累积，因此无法达到进程管理 seam 通常提供的宿主内存边界。
- **Pipe 输出并非字节保真**：E2B 交付的是分别解码后的字符串，而不是原始字节，因此拆分的多字节序列和任意二进制协议可能损坏；不支持 LSP 及其他带帧字节流消费方。
- **不支持需要同步 PID 的消费方**：远程启动期间，`pid` 保持为 `-1`；包括 ACP 子进程后端在内，要求立即获得正 PID 的消费方无法原样使用本提供方。
- **重新连接不会重建句柄**：保留沙箱后，远程 PID／状态／spill 文件仍然存在，但新的 harness 进程不会据此重建实时 `SubprocessHandle` 对象或输出游标。
- **保留沙箱时会累积远程状态**：进程目录和有效的 spill 文件会留在 `.dsh-e2b` 下；本 POC 不提供保留清理。
- **信号归因依靠推断**：如果已经请求终止，而 E2B 报告非零退出码，适配器会报告最后请求的信号，因为 SDK 结果不标识终止信号。
- **依赖 Linux 工具与 E2B 传输语义**：没有 PTY、Windows、任意模板或网络分区的保真层。
