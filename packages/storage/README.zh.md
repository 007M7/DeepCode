# storage/：非会话存储家族

[English](README.md) | 中文

存储家族持久化会话事件日志之外的一切数据：命名后端与类型化数据形式在一个中心相接。设计记录：[领域 KV 存储 Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

| 包 | 职责 | ctx key |
|---|---|---|
| `storage/` | 中心：命名后端注册表 + 可合并扩展的数据形式挂载、后端 facet 词汇、共享一致性测试套件 | `ctx.storage` |
| `storage-json/` | JSON 后端：每个单元一个人类可读文件，以原子方式重写整个文件 | 注册后端 `json` |
| `storage-sqlite/` | SQLite 后端：一个数据库承载所有已路由单元，每行一个文档 | 注册后端 `sqlite` |
| `domain/` | 领域数据形式：经 zod 验证的记录、逐领域写入链、`domain/changed` 事件、按配置路由后端 | `ctx.storageDomain` + `ctx.storage.domain` |

每个后端拥有一种介质，并公开数据形状 **facet**（目前为 `kv`；为未来的会话后端迁移预留 append-log facet）。每个后端插件都会在注册后发布内部生命周期服务；领域插件在公开自身服务前注入每个已配置的后端 key，因此配置树中的行序不携带启动语义。消费方绝不直接接触后端，而是注入 `storageDomain` 并通过它打开已声明的领域。
