# @deepseek-ai/dsh-tasks

[English](README.md) | 中文

进程局部的后台任务注册表（`ctx.tasks`）。它为长时间运行的生产方提供共享 id、owner 隔离、读取、取消、等待、通知和清理。生产方插件使用其不透明 id namespace 扩展 `TaskKindMap`。

## 服务 API

- `start(spec): TaskId` 验证控制表层、spec、精确的存活 owner，以及可选的正 `outputLimitBytes`，然后只调用生产方的 `run()` 一次。启动方抛出异常时不注册任何内容；成功返回会直接提交，不再执行其他可能失败的步骤。
- `get(id, caller?)` 和 `list(caller?)` 返回非消费式快照。列表只包含调用方拥有及无 owner 的任务。
- `read(id, caller?)` 消费流任务的唯一游标；对于最终输出任务，则以幂等方式读取终止输出。
- `kill(id, caller?, reason?)` 在更改状态前调用生产方取消。取消抛出异常时任务保持运行；成功则把状态改为 `stopping`，并将终止交付标记为已报告。
- `wait(id, timeoutMs, caller?, signal?)` 返回终止快照，或在超时时返回存活快照。中止只会停止等待；一旦终止交付已向该等待方提交，终止结果优先。
- `onTaskDone(listener)` 观察每条终止记录及其精确 owner。监听器抛出异常或拒绝会被封装；系统不会等待监听器工作。
- `attachSurface(name)` 在其 effect 生命周期内声明控制表层。如果没有附加任何表层，`start()` 会在生产方执行前失败。

有 owner 的访问会比较任务的 `SessionId` 与调用方。`bash-1` 等 id 可预测，因此这道隔离是安全边界。无 owner 的任务向调用方开放，并持续到服务释放。

`outputLimitBytes` 是生产方拥有的模型呈现策略，会原样携带到快照中。控制表层在添加状态或通知元数据后应用它；注册表不会重写生产方输出，也不会为省略此字段的生产方虚构默认值。

## 生命周期

任务属于其 owner 和后端，而不是生产方工具 fiber，因此重载生产方或表层不会停止任务。某个 owner 的第一个任务会把一个受等待的 effect 附加到精确的 `Agent` scope。owner 释放会取消该对象的任务，等待生产方完全停稳，并移除其快照；复用 agent 或 Session id 无法重定向旧清理。

服务释放会关闭监听器、取消所有存活任务、等待其记录，并从仍存活的 owner scope 分离 effect。如果拆卸取消抛出异常，服务会强制把记录标为失败，并警告工作可能遗留，而不会死锁。取消已返回但始终不终止 `done` 时，系统无法将其与缓慢停止区分开，拆卸可能因此停滞。

参见[任务类型目录](../../../docs/core-data-structures/tasks.md)和[运行时 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md)。

## 模型体验

通过生产方插件和 [`dsh-tool-tasks`](../tool-tasks/README.md) 间接影响；它们会渲染 task id、输出、状态、取消和完成通知。

#### KV Cache 影响

不会直接失效；请求前缀变更由命名消费方负责。

## 已知限制与暂缓事项

- **任务只存在于进程本地**：持久或跨重启执行需要独立生命周期。
- **服务与实现没有拆分**：第二个后端必须先定义塑造该边界的生命周期。
- **流输出只有一个消费游标**：独立观察者需要游标或快照 API。
- **前台工作无法提升**：生产方在启动前选择前台或后台。
- **静默无效的取消可能使拆卸停滞**：只有显式抛出异常才能安全地强制标为失败。
