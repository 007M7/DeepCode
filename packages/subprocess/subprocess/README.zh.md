# @deepseek-ai/dsh-subprocess

[English](README.md) | 中文

进程管理器 seam（`ctx.subprocess`）。抽象的 `SubprocessService` 只暴露一个方法：`spawn(spec): SubprocessHandle`，外加所有消费方共享的词汇：完全显式的 `SubprocessSpawnSpec`、携带基于偏移量的非消费式输出读取器的 `SubprocessHandle`、`SubprocessOutcome`、`CollectedOutput`，以及受管的 `DSH_*` 环境命名空间（`DSH_ENV_PREFIX`、`DshEnvironment`）。本地实现位于 [`dsh-subprocess-local`](../subprocess-local/README.md)。

## 契约

- `spawn(spec)` 立即返回一个实时句柄；`done` 在进程关闭时 resolve，仅在 spawn 层面失败时 reject。
- spec 完全显式（argv、cwd、按流划分的字节上限、spill 上限、宽限期），因为随部署变化的默认值属于调用方 seam 的配置，而不属于某个隐藏的进程管理器默认值（`dsh-bash` 的 request/spec 拆分是这条规则的所属模板）。`argv` 在这里绝不经过 shell 解释；需要 shell 的消费方自行传入 `['bash', '-c', command]`。
- 输出读取器接受全流字节偏移量且从不消费：独立的读取器不会抢走彼此的增量。偏移量滑出内存尾部窗口的读取标记为 `lossy`，并在完整流 spill 文件存在时指向它。
- `kill()` 与 spec 的 abort 信号对整个 detached 进程组执行 SIGTERM→宽限期→SIGKILL 升级；服务响应中止但绝不判定原因（deadline 与原因分类归调用方所有）。
- dispose（资源释放）会终止所有仍在运行的受管进程并等待其退出。

参见[进程数据结构目录](../../../docs/core-data-structures/subprocess.md)与 [seam Agent Note（agent 决策记录）](../../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md)。

## 模型体验

通过消费方 seam 间接影响（目前是 `dsh-tool-bash` 背后的 bash 执行器家族）；进程输出与生命周期面向模型的全部渲染归消费方所有。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **目前只有一个消费方家族**：该 seam 的形状仅在 bash 执行器上得到验证；仓库内其他 spawn 调用点（LSP 服务器、PTY 后端、subagent 传输层）继续保留各自专属的进程处理，直到它们的流与生命周期需求对照本契约得到重新审视。
- **假定 POSIX 进程组语义**：句柄词汇（作为组长的 `pid`、进程组终止、SIGTERM/SIGKILL 升级）没有 Windows 方案。
