# @deepseek-ai/dsh-subprocess-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-subprocess`](../subprocess/README.md) seam 的本地实现：`LocalSubprocessService` 把每个 spec 的 argv 作为 detached 进程组 spawn，收集有界输出，并用限制大小的完整流 spill 文件保留超量内容，随后针对整个进程组从 SIGTERM 逐步升级为 SIGKILL。该实现没有任何配置：每项限制与目录都随 spawn spec 到达，因此随部署变化的旋钮留在调用方 seam 的配置里（目前是 [`dsh-bash-local`](../../bash/bash-local/README.md)）。

## 行为（以及设计来源）

- **带升级的 detached 进程组**：子进程使用 `detached` spawn（拥有独立进程组）；终止时先向该组发送 SIGTERM，经过 spec 的宽限期后再发送 SIGKILL（沿用 OpenCode 的升级策略；管道与子 shell 会随父进程一起结束）。组长进程退出后，继承的 stdout/stderr 管道也只获得同样有界的排空宽限期，因此存活的后代进程无法无限期地阻止这次 spawn 结束。系统会容忍 ESRCH；脱离该组重新挂载的 daemon 仍可能存活，这与调研工具的局限相同。
- **尾部保留截断 + 有界 spill 文件**：输出超过某条流的上限后，内存中保留尾部（错误与结果通常聚集在末尾，沿用 pi/OpenCode 的理由），同时将完整流追加到一个私有临时文件，并在可用时报告该路径。某条流大于 spill 上限时，会丢弃已不完整的 spill，仅返回带截断标记的尾部；最终关闭失败时则不公布路径，以免声称存在不完整的文件。spill 文件权限为 `0600`、名称随机，位于按需延迟创建的 `0700` 每进程目录之下。
- **凭据清除 + 受管 `DSH_*` 合并**：以 `process.env` 为基础，移除形似凭据的变量（`*KEY*`／`*SECRET*`／`*TOKEN*`）和所有环境中已有的 `DSH_*` 名称；spec 的普通 `env` 在清除后合并，但会拒绝 `DSH_*`；受管 `dshEnv` 会拒绝普通名称并最后合并，防止陈旧的嵌套 harness 身份。提供的 stdin 会被写入后关闭；否则 fd 0 指向 `/dev/null`。参见 [stdin/env Agent Note（agent 决策记录）](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md)与[受管环境 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.md)。
- **基于偏移量的读取**：`SubprocessHandle` 的读取器以全流字节坐标返回增量；服务自身从不持有游标，因此消费方自有的游标（bash 的后台读取路径）与完整流重读可以共存。
- **先终止再等待退出的 dispose（资源释放）**：服务保留存活句柄，只为让自身的 dispose 能终止每个仍在运行的进程组并等待其退出；已结算与 spawn 失败的句柄在结算时即离开存活集合。

## 模型体验

通过消费方 seam 间接影响（目前是 `dsh-tool-bash` 背后的 bash 执行器家族）；进程输出与生命周期面向模型的全部渲染归消费方所有。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **仅支持 POSIX**：detached 进程组、进程组终止以及 SIGTERM→SIGKILL 升级都已硬编码；不支持 Windows。
- **凭据清除依赖名称启发式规则**：只匹配 `*KEY*`／`*SECRET*`／`*TOKEN*`；名称不同的 secret（例如 `*PASSWORD*`）会继续传递，对误删变量引入白名单属于已记录的后续工作。
- **不会删除已完成的 spill 文件**：有界的完整输出恢复文件（以及每个进程的私有 spill 目录）会在 OS tmpdir 下累积，直到外部机制进行清理；超大的不完整 spill 会被丢弃并立即尝试删除，但清理失败可能留下一个有界文件。

原始进程处理位于 `src/spawn.ts`；`src/index.ts` 负责服务接线。
