# workspace/：Workspace 实体

[English](README.md) | 中文

Workspace 系列拥有持久 workspace 概念：用户工作所在的目录，包含标题以及属于它的有序会话列表。设计记录：[领域 KV 存储 Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `workspace/` | 位于存储领域形式之上的 `WorkspaceRegistry` 服务：按 realpath 唯一的路径、会话所有权计数、实体缓存 | `ctx.workspace` |

所有权真相存在 workspace 记录的 `sessionIds`（有序）中，绝不从会话 cwd 派生；`attachSession` 会验证会话头的 cwd 解析到 workspace 路径，因此一个会话在结构上最多属于一个 workspace。删除 Workspace 只会移除该注册表记录及账本：目录、用户文件和会话日志都会保留，相关会话则进入 Ungrouped（参见[决策记录](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)）。
