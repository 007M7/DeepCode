# Agent Note（agent 决策记录）：只读凭据与静态 LLM（大语言模型）路由

Status: implemented

[English](2026-07-31-read-only-credentials-and-static-llm-routes.md) | 中文

## 问题

第一版请求级 LLM 配置设计在相应 UI 尚不存在时，便交付了面向未来配置 UI 的能力。凭据 seam 暴露描述、修改和变更事件，因此本地提供方需要 watcher、缓存、操作队列、dotenv 编辑器、写入锁，以及一个新的共享 atomic-write 包（package）。没有生产调用方使用这些操作。可变适配器注册与休眠的 pi-ai 挂载同样是为了让 settings 创建路由而存在，尽管提供方所有权属于组合决策。

这些超前加入的能力占据了该功能大部分运行时与测试增量，扩大了公开契约，还引入了与两个当前消费方无关的生命周期和并发失败模式；这两个消费方只需要为一次请求解析点名的密钥。

## 决策

`ctx.credentials` 只暴露品牌化 `CredentialRef` 的构造，以及 `resolve(ref): Promise<string | undefined>`。`credentials-local` 先读取点名的进程环境值，再按需解析其 dotenv 文件。它不拥有修改、描述、事件、watcher、缓存、编辑器或写入器生命周期；从外部更改任一来源，都会在下一次解析时生效。

LLM 提供方路由、模型／能力元数据、上下文限制、推理（reasoning）默认值与重试策略归组合所有。`registerAdapter()` 返回释放器，而非可变注册句柄。DeepSeek 始终拥有自身唯一的路由，pi-ai 则要求配置一份非空路由映射；settings 只能更改这些现有路由的连接、凭据与请求传输事实。更改固定事实的 settings 代会整代被拒绝。因此，共享 CLI（命令行界面）组合不会挂载空的 pi-ai 适配器。

可选 settings 辅助工具只在组合配置项与存活 settings scope 之间切换消费方的来源 thunk。消费方经该 thunk 读取已提交值，因此辅助工具不需要更新 watcher、派生状态回调或拆卸状态镜像。`settings-local` 将自身的写入协议保留为私有实现，不再为一个已不存在的第二写入方公开工具。

## 曾考虑的替代方案

**为计划中的 web surface 保留凭据写入器。**未来的 UI 可能需要变更与脱敏后的描述，但其确切 RPC、所有权和安全契约尚未交付。届时随消费方重新引入满足需求的最小能力闭包，比在此期间维护通用写入生命周期成本更低。

**缓存 dotenv 文件并通过 watcher 触发失效。**相比一次模型请求，每次解析执行的文件 I/O 很小；直接读取可以让外部轮换始终生效，而无需引入 watcher 就绪、防抖、事件漏失与资源释放语义。

**保留可变路由注册，将其作为通用注册表功能。**当前适配器在组合时便已知自身的提供方路由。可变公开句柄只为一项延后的 settings 驱动路由功能创建了生命周期状态。

**只为 settings 保留共享 atomic-write 包。**一个消费方不足以证明公开包、对等依赖（peer dependency）、不变量配套实现与独立测试面的必要性；settings 提供方拥有自身的私有写入协议。

## 后果

当操作者或外部机密管理器更改环境或 dotenv 文档时，凭据轮换仍然无需重启，但 harness 不提供凭据管理 API 或 UI 契约。pi-ai 部署必须显式组合至少一条提供方路由。余下公开 seam 与当前生产调用相符，被移除的 watcher、编辑器与注册机制也不再引入并发或拆卸状态。

针对 seam、提供方、动态 settings、Loader 组合与凭据缺失快照的聚焦测试固定了这个更小的能力闭包。先前的[请求级配置](../architecture/2026-07-29-request-level-llm-config-credentials.md)与[凭据边界](../architecture/2026-07-30-credential-boundaries-and-atomic-registration.md) note 保留其动机以及仍然适用的请求与安全决策；对于已移除的变更和路由生命周期契约，则以本 note 为准。
