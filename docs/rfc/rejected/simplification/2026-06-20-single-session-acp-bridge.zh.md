# RFC：将 ACP 桥接恢复为每连接单会话

[English](2026-06-20-single-session-acp-bridge.md) | 中文

Status: rejected — Zed 是当前目标 ACP 客户端，其 ACP 实现明确支持多会话：它将活跃会话存储在 `HashMap<SessionId, AcpSession>` 中，跟踪 `pending_sessions`，对同一 id 的并发加载进行合并，并测试加载期间关闭的行为。

## 问题

ACP 桥接现已支持在一条 JSON-RPC 连接上承载多个活跃会话。这一能力带来了多条目会话映射、反向的会话/agent 查找、逐会话的提示词状态、加载中 id、每个事件的解复用、跨会话的销毁，以及未来权限提示与后台任务的隔离问题。早先的[多会话 ACP 提案](../../implemented/feature/2026-06-14-acp-multi-session.md)仍在跟踪未完成的权限归属部分；本 RFC 是与之竞争的简化路径。

产品目标已证明它需要在一个 harness 进程上承载并发的编辑器对话：Zed 的 ACP 连接拥有多个会话和加载状态。快照回放层仍然避免并发模型流，因为其回放条目是位置敏感的；这是测试 fixture 的局限，不是移除桥接多路复用的理由。

## 提案

将 ACP 的作用域收回到每连接一个活跃会话。`session/new` 或 `session/load` 创建唯一的会话记录；在现有会话被 dispose 或连接关闭之前，第二个活跃会话请求将被拒绝。如果编辑器需要多个聊天标签页，可以启动多个 agent 子进程，直到桥接具备具体的多会话 UX 和权限模型。

在单个 `SessionRecord | undefined` 即可满足需求的地方，移除多会话映射和解复用逻辑。桥接仍可保留使销毁行为正确的 agent/会话生命周期 seam；简化仅针对在同一传输层上多路复用多个活跃会话这一点。

## 验收标准

- ACP 每连接仅有一条活跃会话记录。
- 当该记录存在时，`session/new` 和 `session/load` 拒绝请求。
- 事件处理器不再跨 `Map<sessionId, record>` 解复用。
- 多会话测试被移除，或移至继续支持多路复用的提案下。
- 既有的[多会话 ACP 提案](../../implemented/feature/2026-06-14-acp-multi-session.md)更新为链接本 RFC，并继续作为当前方向。

## 放弃了什么

ACP 客户端无法在一个服务器进程上承载多个并发对话。这是一项有实质意义的能力削减。对于一个尚未发布的 harness 而言，更简单的模型仍然合理：一个编辑器对话对应一个 agent 进程，跨会话的权限/后台任务隔离不再是活跃的正确性负担。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
