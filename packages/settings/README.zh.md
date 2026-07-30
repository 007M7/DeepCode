# settings/ — 用户设置能力族

[English](README.md) | 中文

用户设置 seam 及其 provider。接口包拥有抽象 `Settings` 服务——namespace 注册、分层解析与变更提交；provider 实现原始文档存储并把外部修改推入 seam。全部为**产品**包。

| 包 | 角色 | ctx key |
|---|---|---|
| `settings/` | 设置 seam：namespace 注册表、分层解析、提交事件 | `ctx.settings` |
| `settings-local/` | 文件 provider（`settings.yaml`/`.json`），热重载与保留注释的写回 | （注册 `ctx.settings`） |

接口位于 `settings/settings/`；provider 平级并列。网络配置中心 provider（例如 nacos 类后端）加入本组并注册到 `ctx.settings`。组合配置仍留在 `cordis.yml`：settings namespace 只承载用户可编辑子集，解析顺序为 schema 默认值、注册方的组合 `base`、用户文档。
