# workspace/：Workspace 实体

[English](README.md) | 中文

Workspace 系列负责持久 workspace 概念：用户工作所在的目录，包含标题以及属于它的有序会话列表。设计记录：[领域 KV 存储 Agent Note（agent 决策记录）](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `workspace/` | 基于存储领域数据形式的 `WorkspaceRegistry` 服务：按 realpath 去重的路径、会话归属记账、实体缓存 | `ctx.workspace` |

所有权信息以 workspace 记录中的 `sessionIds`（有序）为准，绝不从会话 cwd 派生；`attachSession` 会验证会话头的 cwd 解析到 workspace 路径，因此一个会话在结构上最多属于一个 workspace。删除 Workspace 只会移除该注册表记录及会话归属记录：目录、用户文件和会话日志都会保留，相关会话则进入 Ungrouped（参见[决策记录](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)）。
