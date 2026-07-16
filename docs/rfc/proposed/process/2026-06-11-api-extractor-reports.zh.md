# RFC：API extractor 报告

[English](2026-06-11-api-extractor-reports.md) | 中文

Status: proposed

> 从最初的「Doc-sync 与 API 报告」RFC（2026-06-11）中拆出。第 1、2 部分（文档块类型检查、事件分类体系校验）已交付——见 [doc-sync 强制](../../implemented/process/2026-06-11-doc-sync-enforcement.md)。本文是被推迟的第 3 部分，作为独立提案保留。

## 问题

公开 API 的变更是不可见的：没有任何机制让「这个 commit 改变了公开接口」成为一个显式、可评审的事实。评审者阅读 diff 时可能遗漏一个导出类型新增了字段或方法签名发生了变化。

## 提案

使用 api-extractor（或 `tsc --emitDeclarationOnly` 加一份归一化的公开接口导出）为每个包（package）生成一份签入仓库的 `etc/<pkg>.api.md`；如果重新生成的结果与签入版本不同，CI 失败。这样每一次公开 API 变更都会变成评审者（或评审 agent）必须看到的一行 diff。

## 曾考虑的替代方案

**`tsc --emitDeclarationOnly` 加一份归一化的公开接口导出**：如果 api-extractor 被证明过重，这是更轻量的机制；两者都满足本提案所需的「签入仓库、可 diff」的报告形态。

## 验收标准

- 每个包有一份签入仓库的 `etc/<pkg>.api.md`；重新生成结果与已提交报告不同时 CI 失败。
- 公开 API 变更（新增导出、字段放宽、签名变化）在评审中以报告 diff 行的形式可见。

## 风险

该依赖重且难伺候——这正是它被推迟的原因——且报告格式会随编译器升级而变动，在各包尚未发布的阶段增加了一个收益甚微的维护面。

## 推迟原因

在 doc-sync 落地时被推迟：对于评审者已经能看到源码 diff 的内部 monorepo 而言价值有限，且依赖重、难伺候。如果这些包将来对外发布，届时一份稳定、可 diff 的公开接口报告才值得其维护成本。
