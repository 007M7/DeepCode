# hooks/：hook 桥接 + 共享协议

[English](README.md) | 中文

hooks 子系统让用户可以像使用 Claude Code 和 Codex 一样，在 agent（智能体）生命周期节点扩展 agent：把桥接插件指向现有的 `hooks.json`（或 settings），即可忠实运行这些外部 shell hook。规范的扩展表层本身是 harness 的类型化拦截 seam（见[拦截 seam Agent Note](../../.agents/notes/implemented/feature/2026-06-30-interception-seams.md)）；「原生 hook」只是这些 seam 上的普通 Cordis 插件。这些包是把外部 shell-hook 协议转换到同一表层的**桥接**，另含它们共同依赖的共享协议格式（wire format）库。

| 包 | 职责 | 形态 |
|---|---|---|
| [`hook-protocol/`](hook-protocol/README.md) | 共享 shell hook 协议库 | 库 |
| [`hooks-claude/`](hooks-claude/README.md) | Claude Code hook 桥接 | 插件 |
| [`hooks-codex/`](hooks-codex/README.md) | Codex hook 桥接 | 插件 |

共享库负责通用协议行为；每个桥接负责其方言特有的事件映射。相应契约由子级 README 记录。
