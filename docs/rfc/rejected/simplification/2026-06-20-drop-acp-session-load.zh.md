# RFC：移除 ACP session/load，待恢复功能具备产品形态后再引入

Status: rejected — Zed is the current target ACP client, advertises and exercises load-capable sessions, and keeps pending-load state for concurrent `session/load`. The bridge should keep `session/load` and make the resume contract solid.

[English](2026-06-20-drop-acp-session-load.md) | 中文

## 问题

ACP（Agent Client Protocol）当前通告 `loadSession: true` 并实现了 `session/load`：向 bridge 注入持久化能力、校验 cwd 与存储元数据的一致性、从持久化日志重建 agent、并向客户端回放先前的 transcript（文本记录）更新。这条路径有自己的竞态处理、loading-id 守卫、回放展示逻辑和测试。它还依赖规范日志保留足够的 UI 数据来重建旧的分片和工具展示。

持久化本身仍是基础能力，但编辑器可见的恢复功能尚未经过产品流程设计。目前没有会话选择器、没有标题/预览元数据，对加载失败或部分加载也没有清晰的用户体验。bridge 正在为一个仅由测试、文档和当前目标客户端的会话模型所使用的功能承担复杂度。

## 提案

暂时只支持新建会话。`initialize` 通告 `loadSession: false` 或省略该能力，`session/load` 不予支持。持久化仍可供 agent loop（智能体循环）和测试使用；如果其他消费方需要，恢复功能仍可作为底层工厂存在。编辑器 bridge 应在具备真正的会话选择 UX 和稳定的加载 transcript 契约后，再重新引入 `session/load`。

## 验收标准

- ACP 不再仅为 `session/load` 注入 `sessionPersistence`。
- `initialize` 不通告加载支持。
- `session/load` 处理器、loading-id 追踪、已加载会话的 cwd 预检以及加载回放测试全部移除。
- 快照 fixture（测试前置数据）不再依赖加载回放的展示逻辑。
- [ACP 文档](../../../../packages/ui/acp/README.md)仅描述新建会话的支持。

## 放弃了什么

编辑器无法通过 ACP 重新打开先前持久化的会话。这确实是一个有价值的产品功能，但当前实现超前于 UX 设计，且将 bridge 绑定在 token 级别的日志回放上。保留持久化但移除编辑器加载，将 bridge 收窄到它当前能干净呈现的工作流。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
