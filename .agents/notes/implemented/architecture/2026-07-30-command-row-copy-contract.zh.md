# Agent Note: Command row copy is split between the row and the handler

Status: implemented

[English](2026-07-30-command-row-copy-contract.md) | 中文

## Problem

Web 命令行由一对落库的[命令生命周期事件](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md)渲染出 `标题 · 摘要`：标题是由 `command/run` 重建的分派命令行（`/permission workspace-write`），摘要是 `command/done` 的原样 `text`（`Permission preset: workspace-write.`）。两半各自成文、互不知情，于是一行里命令名出现两次、参数也出现两次——最糟的一例正是用户每次用 Access chip 切换权限时得到的那一行。

## Decision

命令行两半的职责互不重叠，各自只按自己那一半来写。

行标题就是裸命令名——没有 `/`，也没有参数。`/` 属于编辑器的输入语法，不属于一条已落定的记录；参数也不该由这一行来报告：摘要已经说清了这条命令做了什么。对于 `command/run` 那一页已滑出客户端窗口的跨窗口节点，`GenericCommandCard` 仍保留 `命令` 兜底标题。

因此，命令 handler 的落定 `text` 绝不重复命令自身的名字——渲染它的界面已经说过一次了。`/permission` 返回 `preset workspace-write`，裸调用时返回 `current preset workspace-write (available: …)`。作为一行读是 `permission · preset workspace-write`；作为独立一句读——TUI 把同一段 text 作为通知追加——它依然说明了当下生效的是哪个预设。

日志本身未变：`command/run` 保留结构化的 `name`／`args` 拆分，因此更丰富的已注册命令行仍可从同一个节点渲染参数，无需第二条数据通道。

## Alternatives considered

**保留分派命令行作标题，只缩短落定文案。** 参数仍会出现在分隔点两侧（`permission workspace-write · preset workspace-write`），而这正是被指出的重复。

**从折叠行中去掉落定文案，而不是去掉参数。** 这颠倒了这一行的价值：持久记录存在的意义就是结果，而错误文案将无处落脚。

**由这一行从落定文案里剥掉开头的命令名。** 呈现层会悄悄改写 handler 写就的文案，而任何换一种措辞表达结果的 handler 都会让这套启发式失效。

## Consequences

每一条命令行都变短了，而且这条规则可扩展：新命令的作者写结果时无需知道由哪个界面渲染，任何界面也都不必再去重。代价是分派参数离开了折叠行——命令仍在执行时，行上只有名字和 `执行中…`——以及"不重复"这条规则是靠评审执行的约定，而非门禁。`/permission` 的文案由 permission 包的命令测试钉住，装配后的行文案由 [seeded-history](../../../../apps/web/tests/snapshots/seeded-history/command-row.expected.md) web 预期输出钉住：因为 `/permission` 完全在 host 上执行，它能无密钥地抵达一条真实的落定命令行。
