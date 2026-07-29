# boot/：共享的 app bin 启动粘合层

[English](README.md) | 中文

各 app bin 共享、与通道无关的启动库。一个角色完备的单包组：它不归属任何通道也不归属任何组装——`apps/cli`、[`scaffold/`](../scaffold/README.md) 启动器和 [`examples/`](../examples/README.md) 各演示 bin 都消费它。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `app-boot/` | app bin 的共享启动粘合层：加载 `.env`、会明确报错的 Loader 保护机制、感知快照的配置解析，以及等待整棵树停稳的启动序列 | （供各 bin 使用的库） |
