# session-registry/：活跃会话注册表家族

[English](README.md) | 中文

当前正在运行哪些会话，可以从另一个进程读取。消费方是 `dsh list-sessions`。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-registry/`](session-registry/README.md) | seam：抽象注册表服务契约与记录词汇 | `ctx.sessionRegistry` |
| [`session-registry-file/`](session-registry-file/README.md) | 后端：单个加锁保护的 JSON 文件、由 pid 推导的存活状态 | — |
| [`session-registry-live/`](session-registry-live/README.md) | 发布方：跟随会话生命周期与标题事件，让注册表保持同步 | — |

这样拆分遵循由三个包构成的能力 seam 惯例：seam 要回答「哪些会话是活跃的」，供一个不挂载其他任何东西的短生命周期读取方使用；文件后端拥有今天的介质，将来可以换成数据库而不触及消费方；发布方需要会话存储，运行在完整的 agent（智能体）组合体内。存活状态在读取时由记录的 pid 推导，而不是存下来，因此进程被杀掉后不留下任何需要清理的东西。记录自带标题，因为日志位置、格式和压缩都是各部署自行选择的后端方案，独立的读取方无法以可移植的方式解析。

这个家族与会话持久化相互独立：它只记录哪些进程持有哪些会话，绝不记录对话内容；从未被持久化的会话同样能被列出。
