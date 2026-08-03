# preset/：按会话组装 agent

[English](README.md) | 中文

**agent preset** 是一个目录，其中放置一份 `agent.cordis.yml`。把它挂载到某个 agent（智能体）的 scope 上下文之下，该会话就获得自己的工具与提示词段落，而其他在运行的会话各自保持不变，因此一个进程可以同时运行多个组装方式不同的 agent。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `agent-presets/` | preset 词汇、在受信任目录与用户自建目录上的文件系统发现，以及带校验的按 agent 挂载 | `ctx.agentPresets` |
| `persona/` | 把 agent 人设做成可组装的行，使 preset 不止能改工具、也能改身份 | — |

部署随附三个 preset：`standard`（完整编码 agent）、`core-web`（两个工具的 benchmark 表层），以及 `cordis`（标准 agent 加上自指工具集与一份组装创作 skill，使人可以让 agent 去创作另一个 agent）。

本组假定的组装划分是：注册表与跨会话设施是进程单例，留在宿主组装中；preset 只承载单个 agent 对它们的贡献。若 preset 中某一行发布了进程级全局服务，挂载时即被拒绝，而不是留到与下一个会话相撞。

设计详见 [按会话组装 agent preset 的 Agent Note](../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md)。
