# RFC：简化会话日志表示

[English](2026-07-12-simplify-session-log-representation.md) | 中文

Status: proposed

## 问题

会话日志维护着两种表示，其机制开销超出了消费方的实际需求：伪链表 surface 与自定义请求头增量编码。

`SurfaceManager` 将同一顺序存储在数组、seq 映射和可变的 `prev`/`next` 链接三处。生产代码从不读取 `prev`；压缩（compaction）唯一一次读取 `next` 是取数组位置的后继。替换操作已经使用 `indexOf`，因此链接并未使其主要操作达到常数时间。一个 seq 数组加线性替换查找具有相同的渐近替换开销，且只有一种表示需要校验。

请求头子系统实现了自定义的 system/tool 增量编解码器与传输决策层，尽管其契约声明增量只是编码优化而非可重建性要求。在每个 agent loop 实例边界保留 initial/resume 完整快照，然后在该实例的组装头发生变化时写入一条规范的完整 `request/header`，即可保留回放能力，同时删除 `SystemDelta`、`ToolsDelta`、往返 fallback 以及持久化的 `request/header-delta` 变体。编解码器专用词汇随编解码器一起消失，并非因为其各分支本身无效。

本提案有意保留 append 与 replacement 的 `sourceEventSeqs`、崩溃恢复溯源，以及所有 `SessionStartSource` 变体：已实施的 RFC 赋予了这些字段审计/拦截角色，零当前读者不足以推翻这一点。

## 提案

将 `SurfaceManager.nodes` 改为事件序列号的 `readonly number[]`，移除公开的 `SurfaceNode` 形状。保留内部的 replace-generation 信号；更新工具配对平衡与压缩调用方，使其通过数组值/索引获取前驱、后继与替换范围，移除节点链接与 seq-to-node 映射。将锚点后的请求头增量替换为规范的完整变更头快照，移除增量编解码器/事件/测试；initial 与 resume 锚点即使折叠后的头未变也仍为完整快照。

修订会话 surface 与可重建请求的 RFC 中描述已移除编码的部分。更新事件类型/不变式、请求日志/回放、持久化 fixture（测试前置数据）、生成的 catalog、包文档与快照。将编解码器专用的 `fallback` 原因替换为显式的 `change` 原因（用于锚点后的完整快照），以区别于保留的 `initial` 与 `resume` 锚点。

`SESSION_FORMAT_VERSION` 有意保持为 `0`，因此包含 `request/header-delta` 的旧 v0 日志在增量折叠被删除后，若不做处理将通过版本检查并静默丢失头变更。seed/load 校验必须在格式边界处拒绝该遗留事件并快速失败；不添加兼容折叠或迁移。

## 曾考虑的替代方案

**保留链表节点与紧凑增量以备未来规模。** 链接可能有助于未来的游标 API，增量在大型工具 schema 仅有少量变化时能减小日志体积。但没有已发布的游标使用这些链接，而完整快照以磁盘空间换取显著更简单的正确性。如果头部体积确实成为问题，可以基于真实 trace 设计压缩方案或经过度量的规范增量方案。

## 验收标准

- `SurfaceManager.nodes` 是一个有序 seq 数组，没有 `SurfaceNode`、链接字段或 seq-to-node 映射；增量追加处理与内部 replace-generation 信号保留。
- 回放完整变更头快照能重建出完全相同的请求；不再存在任何 header-delta 事件/类型/编解码器。
- 包含遗留 `request/header-delta` 的 v0 seed 或持久化日志在回放前被拒绝，JSONL 与 SQLite 加载路径均有覆盖。
- 新形状的 v0 JSONL/SQLite 回放、溯源、崩溃恢复、压缩、快照、不变式、类型检查、覆盖率、doc-sync、构建与 hygiene 全部通过。

## 风险

完整头会增加日志体积，线性替换查找在非常大的 surface 上可能更慢。替换操作目前已经是线性的，因为实现调用了 `indexOf`；只有在真实 trace 表明更简单的数组成为瓶颈时才应添加基准测试。由于格式版本保持为 `0`，如果遗漏了对遗留事件的显式拒绝，后果将是静默数据损坏而非类型错误；因此快速失败的加载测试是本提案的组成部分，而非可选的清理工作。
