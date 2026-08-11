# Agent Note：把命令行接缝收窄到既有接口

Status: implemented

[English](2026-08-11-cmdline-seam-trim.md) | 中文

## 问题

应用自有命令行（[笔记](2026-08-06-app-owned-command-line.md)）交付时带着三条比其消费者所需更宽的接缝：一台 vendored 的内存行激活状态机（`Entry.enableRuntime`，外加从 `dsh-cmdline` 导出的 `enableRow` —— 一个命令行包拥有了 Loader 概念）、一个只有 Include 一个实现者的 vendored `EntryConfigResolver` 协议符号，以及仍然识别 `headless-runner` 行的启动器 —— 用它选择 SIGTERM 退出码、门控用户 patch 监视，并提供与 `ctx.appExit` 重复的 `headlessIo` 接缝。

## 决策

三者全部改用已经存在的接口表达：

- **条件 dev 行。** `dsh-web-app` 不再随附禁用的 `client-hmr` 行；开发模式下其 runtime 插件在 Loader 结算后用普通的 `loader.create` 在根树中创建该行，并带重载幂等保护。根树的行在 include 之外，用户 patch 的重新应用无法把它恢复为禁用 —— 这正是内存覆盖机制存在的理由。增量式客户端模块扫描会在任何页面加载之前把它加入名录；浏览器只会在人读到 URL 行之后到来，其 `EventSource` 按规范自动重连。`Entry.enableRuntime`、它的两个状态字段和 `enableRow` 一并删除。
- **树载体配置。** Include 改为声明已有的 `EntryGroup.key` 标记，不再实现 `EntryConfigResolver`；Loader 钩子让每个树载体的配置保持字面值。Include 自己的 `path` 失去 `!!js` 支持 —— 从未有配置用过它，固定该行为的测试改为断言字面值树载体约定。
- **启动器的应用知识。** 启动器不再识别任何应用行。SIGTERM 是监督进程的普通停止请求，在所有 surface 上以 0 退出（SIGINT 仍为 130）；启动器无从知道应用是否认为工作已完成，而之前的 143 依赖于点名 headless 行。每次启动都监视用户 patch 层 —— 一次性 surface 经由有界关闭退出，关闭会先 dispose 监视器再排空事件循环。headless runner 像任何应用一样经 `ctx.appExit` 退出；其输出流是包内 `internals` 测试接缝，`ctx.headlessIo` 删除。

## 考虑过的替代方案

- **保留 `enableRuntime` 但把 `enableRow` 移出 `dsh-cmdline`**：搬迁修正了包边界，却保留了 vendored 状态机，其语义（在重新应用后仍生效、失败时回滚）在每次上游同步时都要重新推导。
- **`entry.update({ disabled: null })`**：改写条目的序列化选项，下一次 include 重新应用会恢复 `disabled: true` 并在会话中途卸载该行。
- **通过应用注册的信号处理器为一次性 surface 保留 SIGTERM 143**：启动器自己的处理器会与它竞争退出码；要赢得竞争需要新的启动器接口，而这正是本次变更要移除的成本。

## 后果

- 用 SIGTERM 监督 `dsh --profile headless` 的部署现在观察到退出码 0 而非 143；信号是调用方自己发的，且 stdout 上没有答案。
- `--dev` 重载行不在启动激活审计的覆盖内；创建失败只记录日志，不致命。
- 一次性运行会挂载之前跳过的配置监视行，启动多花几毫秒。
- vendored Loader/Include 偏差减少一个协议符号和一台状态机，`rescope-vendor:check` 重新通过（修改日志的 rescope 条目回到其精确编辑锚点要求的位置）。
