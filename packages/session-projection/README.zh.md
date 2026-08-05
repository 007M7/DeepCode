# session-projection/

[English](README.md) | 中文

会话投影能力家族：领域 host 插件经由此 seam，把日志派生的按会话状态的当前全量值供给客户端载体。

| 包 | ctx 键 | 职责 |
|---|---|---|
| [`session-projection`](session-projection/README.md) | `sessionProjections` | 接口包：merge-extensible 的 `SessionProjectionMap` 类型表、`ProjectionDefinition` 单元契约，以及供载体同步读取的主动驱动注册表 |
| [`session-projection-cache`](session-projection-cache/README.md) | `sessionProjectionCache` | 持久投影缓存：基于域数据形态的按会话单元检查点持久化、带 turn/end + detach 两个必写点的节流后写，以及冷读阶梯（缓存行 + 持久化尾部回放） |
