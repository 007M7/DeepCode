# session-projection/

[English](README.md) | 中文

会话投影能力家族：领域 host 插件经由此 seam，把日志派生的按会话状态的当前全量值供给客户端载体。

| 包 | ctx 键 | 职责 |
|---|---|---|
| [`session-projection`](session-projection/README.md) | `sessionProjections` | 接口包（package）：merge-extensible 的 `SessionProjectionMap` 类型表、`ProjectionDefinition` 单元契约，以及供载体同步读取的正向驱动注册表 |
