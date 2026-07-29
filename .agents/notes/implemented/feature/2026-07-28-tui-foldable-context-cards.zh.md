# Agent Note: TUI 中的可折叠注入上下文卡片

Status: implemented

[English](2026-07-28-tui-foldable-context-cards.md) | 中文

## 问题

TUI 会将每条注入上下文消息（即一条来源不是 `user` 的 `user/message`：`workspace-context`、`goal` 及其他插件）渲染为 transcript（文本记录）中的三个零散子项：暗色的 `Context · <label>` 标题、消息的 XML 根元素名称（`system-reminder`）和正文，并且始终完全展开。这种呈现有两处影响阅读。第一，与工具调用卡片不同，上下文卡片无法折叠，因此较大的 `workspace-context` 提醒会一直占据 transcript，无法通过 `Ctrl+O` 折叠。第二，XML 根元素会直接显示在已经注明来源的 `Context · workspace-context` 标题下方，单独形成一行字面值（`system-reminder`）；这使外框元素成为重复标题信息的原始 XML 噪声。

## 决策

注入上下文渲染为 `ContextCardComponent`（`packages/ui/tui/src/components/transcript.ts`）。这是一个可折叠的暗色卡片，与工具卡片共用 `Ctrl+O` 切换操作，初始状态为折叠。其标题仍是暗色的 `Context · <label>` 行。正文是去掉多余外框行后、以暗色文本按行渲染的消息内容：来源标签已经指明上下文，因此正文直接从指令内容开始，不再显示 `system-reminder` 行。正文通过共用的 `preview` 辅助函数折叠到卡片的 `maxToolOutputLines` 行数限额，并显示 `… +N lines (Ctrl+O to expand)` 标记。折叠与去外框都不依赖载荷的语法（[与内容无关的折叠](../bug-fix/2026-07-28-context-card-content-independent-fold.md)、[渲染为文本](../bug-fix/2026-07-28-context-cards-render-prose-not-xml.md)）；本记录最初的实现是把两者都走 `renderUnknownXml`。

`Ctrl+O` 让共享的 `toggleTools` 处理器在三种状态间循环——折叠预览、展开、隐藏——与 Codex 的行为一致：隐藏阶段把工具卡片（连同卡片自渲染的前导空行）从 transcript 中完全去掉。上下文卡片承载的是注入指令而非工具流量，因此从不隐藏；隐藏阶段对它们呈现为折叠预览。通知文本按状态命名（`Tool and context cards {collapsed|expanded}.` / `Tool cards hidden.`），`/help` 中的快捷键说明为 `Ctrl+O cycle cards (collapse/expand/hide)`。`renderEvent` 将每张上下文卡片记录在 `contextCards` 集合中，与 `allToolCards` 并列；`rebuildTranscript` 会清空该集合。

标签派生逻辑可以处理非对象形态的来源（既不是会话引用卡片也不是对象的无效注入来源）：系统会回退到通用的 `context` 标题，而不会从非对象值中解引用 `plugin`／`kind`。`sessionReferenceCard` 分支（引用会话的单行条目）保持不变，其中没有可折叠内容。

此变更仅限于 TUI。它涉及 `transcript.ts` 中 `ContextCardComponent`／`ToolCardComponent` 的连接，以及 `packages/ui/tui/src/index.ts` 中的 `renderEvent`／`toggleTools`／帮助信息路径。生产方、会话事件和其他 UI 桥接层（ACP、JSON-RPC）均无需变更；折叠方式属于 TUI 的局部实现，并非跨包契约。

## 考虑过的替代方案

**保持上下文卡片完全展开，仅去掉根元素行。** 不予采纳：最主要的问题是较大的 `workspace-context` 提醒无法像工具卡片一样折叠。只去掉多余的外框行，仍无法解决 transcript 占用问题。

**为上下文卡片设置独立快捷键，与工具卡片分开。** 不予采纳，选择共享 `Ctrl+O`：统一按键符合现有认知模式，无需学习或记录新的按键；两类卡片的折叠目的相同，都是减少 transcript 噪声。循环的隐藏阶段只作用于工具卡片，理由与共享按键成立的理由相同：隐藏注入指令会移除用户无法从其他卡片找回的内容。

**在 `renderUnknownXml` 内统一隐藏根元素行。** 不予采纳：`renderUnknownXml` 还用于渲染未知的工具结果，此时根元素具有实际意义。隐藏根元素是上下文卡片的呈现选择，应由 `ContextCardComponent` 负责，从而保持工具卡片路径不变。

## 后果

`workspace-context` 提醒可以通过折叠工具卡片的同一个 `Ctrl+O` 折叠，其正文也不再在标题下方显示多余的 `system-reminder` 外框行。代价是共享循环逻辑需要额外跟踪第二种卡片，并为无效注入来源增加一小段标签形态回退逻辑。由于此变更仅限于 TUI transcript，ACP 和 JSON-RPC 桥接层会保留各自的注入上下文呈现方式。

## 测试

`packages/ui/tui/tests/tui.spec.ts` 固定以下行为：上下文卡片默认折叠并显示 `Ctrl+O to expand` 标记；按下 `Ctrl+O` 后展开，并显示 `Tool and context cards expanded.` 通知；在隐藏阶段以折叠预览存活、而工具卡片在重绘后消失；第四次按键回到 `collapsed`；不显示 `system-reminder` 外框行；将不带外框的上下文渲染为暗色文本；空外框只渲染标题。`packages/ui/tui/tests/snapshots/` 下的无密钥终端快照通过实际组装的 TUI 和伪终端渲染，并已重新录制；其中展示了不带外框元素的上下文卡片、更新后的切换通知，以及更新后的 `/help` 快捷键说明。
