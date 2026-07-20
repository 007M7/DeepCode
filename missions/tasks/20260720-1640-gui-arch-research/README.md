# 任务理解 — GUI 功能点 → 架构演进预判调研

## 任务

用户给了一份 DSH GUI 功能点清单（[feature-list.md](feature-list.md)，多为待定/远期）。本任务**不是实现这些功能**，而是预判：这些功能要求现有架构还要长出哪些技术演进项。

产出：`report.md`（中文，供用户 review），核心结构：

1. 按功能簇组织（左边栏 / 聚合视图 / session 界面 / trace / 输入框 / plugin / config / onboarding），每簇一张「已覆盖 / 缺口 / 演进项」表；
2. 演进项跨簇聚类成主题，标注压在哪个现有接缝上 + 粗略依赖顺序；
3. 区分「契约加法（additive，符合预留纪律）」vs「需要新 RFC 的结构变化」；
4. 诚实标注不确定处，列成问题清单供用户拍板；
5. 一处一行链接引用现状材料，不复述。

不设计具体方案，只指认「架构上必须长出什么」。

## 现状材料清单（先读）

- missions/conventions.md（规矩）
- 三篇 RFC：gui-layering-and-rpc-protocol / gui-web-client-architecture / web-styling-system（.zh）
- missions/tasks/20260719-2339-web-cordis-design/blueprint-v2.md + design.md（web-cordis 双端插件蓝图）
- missions/ui-product.md、ui-tech.md（旧定稿，可采可推翻）
- missions/tasks/20260720-0300-web-dev-2-onboarding/audit.md 末尾 TOP 清单（现役债）
- packages/host/apiproxy/src/api/（v1 契约现状与预留座）

## 值得核对的现有接缝（提示不设限）

父子谱系锚（host/session-added parentSessionId）、session.fork/task.list/host.listModels 预留座、SessionEventMap merge-extensible + 未知事件 documented-default、model-visible⟺logged 纪律、compact 事件、ACP render intent 三型、settings-research 归档、multiclient 调研。

## 约束

- 只调研，不写产品代码，全程零 commit。
- 分批落盘，每批一句回执（防 API 掉线丢内容）。
