# RFC：移除可变的会话摘要

Status: implemented

[English](2026-06-19-drop-mutable-session-summary.md) | 中文

## 问题

[会话持久化 seam](../architecture/2026-06-14-session-persistence.md) 将会话的日志外元数据拆分为 `dsh-session` 拥有的两种类型：一个不可变的 `SessionHeader`（`version`、`id`、`createdAt`、`cwd?`、`parentSession?`），在创建时一次性写入；一个可变的 `SessionSummary`（`updatedAt`、`title?`、`firstPrompt?`），「无需触碰仅追加日志即可更新」。二者的联合类型为 `SessionMeta = SessionHeader & SessionSummary`，抽象的 `SessionPersistence` 服务为此多出第七个方法 `update(id, summary)`，用于重写摘要。各后端各自实现可变存储：JSONL 在日志旁写一个独立的原子 `.summary.json` **伴随文件**（临时写入 + rename，尽力而为）；SQLite 在追加事务内更新 `updated_at`/`title`/`first_prompt` **列**。

摘要的设计初衷是服务于未来的会话选择器（通过 `updatedAt` 排序、用 `title`/`firstPrompt` 预览）。该选择器从未实现。对整个仓库的审计表明，`SessionSummary` 的全部表面积都是**死状态**：

- `SessionPersistence.update()` 的**生产调用方为零**（所有 `.update(` 命中都是 `createHash().update()` 或测试代码）。
- `firstPrompt` 在生产代码中**从未被读取**。
- `title` 确实在 ACP bridge 中被读取，但来源是工具调用的 **presenter**（`present.title`），而非存储的会话元数据。
- `updatedAt` **没有消费方**：`list()` 唯一的生产调用方读取的是 `meta.cwd`（`SessionHeader` 字段），用于在 `session/load` 时校验工作区；resume 读取的是 `createdAt`/`cwd`/`parentSession`，全部是 header 字段。
- 决定性的事实：活跃的 `Session.header` 早已被类型化为 `SessionHeader` 而非 `SessionMeta`——摘要从未存在于活跃会话对象上；它只存在于持久化层，除了自身的契约测试之外无人写入、无人读取。

## 决策

彻底删除可变的会话摘要。`SessionSummary` 与 `SessionMeta` 这个名称一并移除；后端存储和返回的元数据仅为 `SessionHeader`。`SessionPersistence.update()` 从抽象服务和所有后端中移除。JSONL 去掉整套伴随文件机制（`writeSidecar`/`readSidecar`/`touchSummary`/`removeSidecars`/`sidecarPath` 以及 load/list 的覆盖逻辑）；SQLite 删除 `updated_at`/`title`/`first_prompt` 列及每次追加时的 `updated_at` 更新，其 `SCHEMA_VERSION` 从 `1 → 2`。

摘要原本要提供的一切，在消费方真正需要时都**可从仅追加日志中派生**（`firstPrompt` = 第一条 `user/message`；最近活跃时间 = 最后一个事件的 `time` 或文件 mtime），或者已经存在于不可变的 header 中（`createdAt`、`cwd`）。唯一*不可*派生的——用户*手动编辑*的标题——没有任何实现，纯属 YAGNI；如果未来真有功能需要，它可以作为独立的日志事件或 header 字段回归。

将此记录为决策，是因为它**持久**（收窄了一个公开服务契约和两个后端的磁盘格式）、**有争议**（摘要是有意的前瞻性设计，不是意外产物）、**出人意料**（未来读者看到 `SessionHeader` 而原始 RFC 描述的是 `SessionMeta`，否则会疑惑摘要为何消失）。它还为[共享持久化写入协调器](../architecture/2026-06-18-shared-persistence-write-coordinator.md)扫清了障碍：没有可变摘要，协调器的钩子接口就不需要 `updateSummary` 钩子，JSONL 伴随文件与 SQLite 列之间的持久性差异也随之消失，两个后端的写入路径得以收敛。

## 无需迁移

这是未发布的软件（见[根 AGENTS.md](../../../../AGENTS.md)「预发布立场：地基优先于爆炸半径」一节），因此不存在需要保留的磁盘数据库或日志。SQLite 不迁移 v1 数据库：`openDatabase` 守卫现在拒绝任何非当前版本的磁盘 `user_version`（`onDisk !== 0 && onDisk !== SCHEMA_VERSION`），无论更旧还是更新，因此陈旧的 v1 数据库会被干净地拒绝，而非在新列集上半读半错。新建数据库写入当前版本号；这是唯一需要工作的路径。

## 后果

未来的会话选择器现在必须从日志派生预览和排序信息（或重新引入一个类型化字段），而不能直接读取现成的摘要行。这是正确的代价：为一个不存在的功能维护缓存，是每个后端都要承担的死重，也是每个契约测试都要断言的负担。这一原则——**通过的测试固定的是当前行为，不一定是正确行为；行为可能是过去妥协的产物**——现已作为独立约定记录在[根 AGENTS.md](../../../../AGENTS.md) 中，本次变更即为其实例。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
