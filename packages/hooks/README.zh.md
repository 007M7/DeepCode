# hooks/：hook 桥接 + 共享协议

[English](README.md) | 中文

hooks 子系统让用户可以像使用 Claude Code 和 Codex 一样，在 agent（智能体）生命周期节点扩展 agent：把桥接插件指向现有的 `hooks.json`（或 settings），即可忠实运行这些外部 shell hook。规范的扩展表层本身是 harness 的类型化拦截 seam（见[拦截 seam Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-06-30-interception-seams.md)）；「原生 hook」只是这些 seam 上的普通 Cordis 插件。这些包是把外部 shell-hook 协议转换到同一表层的**桥接**，另含它们共同依赖的共享协议格式（wire format）库。

| 包 | 职责 | 形态 |
|---|---|---|
| `hook-protocol/` | 共享协议格式核心：matcher 原语、退出码／stdout codec、`runHook`（通过 `ctx.bash`）、最严格合并、`hook/*` 会话事件、分离运行完全停稳 | 库（非插件） |
| `hooks-claude/` | Claude Code `hooks.json`／settings 的桥接 | 插件 |
| `hooks-codex/` | Codex `hooks.json` 的桥接 | 插件 |

Codex 有意重新实现 Claude Code 协议的一个*子集*（`hooks.json` 结构相同、5 个事件而非 CC 的众多事件、仅命令、仅正则表达式 matcher、没有 env／替换），因此 `hook-protocol` 负责真正相同的原语，每个桥接只负责不同部分（逐事件 stdin 载荷、env，以及把 hook 的中性结果映射到 harness 类型化 Decision 的方式）。参见 [hook-protocol/README.md](hook-protocol/README.md)。
