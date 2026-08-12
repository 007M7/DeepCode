# Agent Note: Web `/export` 共用流式 Session ZIP 下载

Status: implemented

[English](2026-08-11-web-export-command-and-dialog.md) | 中文

## Problem

Session 导出需要一个稳定的 Session 级外显入口，以及语义等价的斜杠命令路径。第二套后端读取器或 Host 路径写入器会重复下载实现，并引入平台相关的文件权限和路径公开问题。

## Decision

`@deepseek-ai/dsh-session-export` 注册 Web 专用的 `/export` 用户命令，并提供浏览器 `ctx.sessionExport` 控制器。该命令记录普通的 `command/run` 和 `command/done`；`command.execute` 返回成功结果后，`dsh-client-ui-command` 会发布本地确认，请求当前浏览器的控制器下载 ApiProxy 现有的 `GET /api/session.export` ZIP。其他客户端会渲染广播的命令节点，但不会重复执行浏览器副作用。Session Header 中 111×32 的 `Session log` 胶囊按钮会直接调用该控制器。因此，两种入口共用同一个 Host 端点、浏览器保存操作、进行中状态、错误处理和 Modal。

Header 贡献占用最右侧的 `conversation.session.header.utilities` 列表，渲染带尾部下载图标的 `Session log` 文字 capsule 和共享 Modal。标题旁的 `conversation.session.header.actions` 列表继续承载模式、Subagent 和 Task 配置项，挂载 Session export 不会改变它们的顺序或位置。导出贡献不观察 Session 历史。逐 Session 控制器会折叠并发操作，在插件释放时取消活动 fetch，忽略释放后的迟到请求，并在请求后来完成时保留用户已经关闭弹窗的状态。

ZIP 端点与持久化 `readRaw` 能力仍由 `dsh-host-apiproxy` 和持久化包拥有。端点会在读取工件前 flush 活动的根 Session，因此本地确认不会早于持久命令生命周期行。本包不序列化 Session 事件、不写 Host 文件、不交付 Host 路径，也不实现 SQLite 回退。

本包通过 `tsconfig.host.json` 编译 Host 命令和 invariant，`tsconfig.client.json` 则负责浏览器控制器、Header 操作、Modal 及其带编译面后缀的测试。仓库的 Host 和 Client 聚合只引用对应项目，因此两种不兼容的 Cordis `Context` 合并不会进入同一个 TypeScript program。

## Alternatives considered

**把外显入口放进 Trajectory。** 不采用，因为导出是 Session 级操作，用户不应先打开诊断视图才能发现它。

**让 `/export` 写入 Host 侧 JSONL 文件。** 不采用，因为这会偏离包含子 Session 与附件的 ZIP，需要处理 Windows ACL，并返回对远程浏览器可能没有意义的 Host 路径。

**同时保留 Header 与 Trajectory 按钮。** 不采用，因为两个外显控件执行同一项 Session 操作，会形成重复归属和不一致的位置。

## Consequences

Header 操作与 `/export` 会下载同一个 ZIP，并显示相同反馈。已执行命令保留在持久文本记录中，且不创建模型轮次。持久化后端没有逐 Session 原始工件时，用户会收到端点现有的失败；SQLite 支持保留为独立工作。Session 首轮前的命令可用性属于独立工作。
