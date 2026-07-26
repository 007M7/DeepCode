# session-query/：会话取回功能家族

[English](README.md) | 中文

针对实时和持久会话日志提供可信的精确读取、关系跟踪、与提供方无关的语义过滤和 SQLite 全文搜索。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-query/`](session-query/README.md) | 组合式服务契约：提供具体的逻辑语料库读取、跟踪和语义过滤，以及抽象全文方法 | `ctx.sessionQuery` |
| [`session-query-sqlite/`](session-query-sqlite/README.md) | 具体服务后端：使用 SQLite FTS5 持久基库和实时覆盖层 | `ctx.sessionQuery` |
| [`tool-session-query/`](tool-session-query/README.md) | 工作区授权的面向模型搜索、血缘、关系和精确事件工具 | 无 |

查询服务与压缩无关：它读取规范血缘、接口操作、已记录来源信息和语义事件文本，但不参与压缩策略或执行。一个抽象服务组合全部查询操作；一个具体后端负责全文生命周期，无需提供方注册表或协调器；消费方将过大的纯文本结果交给通用执行后 spill 策略。
