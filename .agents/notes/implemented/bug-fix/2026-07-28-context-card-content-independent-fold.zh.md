# Agent Note: 上下文卡片的折叠与文本能否按 XML 解析无关

Status: implemented

[English](2026-07-28-context-card-content-independent-fold.md) | 中文

## 问题

[可折叠的注入上下文卡片](../feature/2026-07-28-tui-foldable-context-cards.md)此前只折叠按树形渲染的正文。`ContextCardComponent.render` 把 `expanded` 和 `maxOutputLines` 传给 `renderUnknownXml`，而当文本不是一个完整的 XML 文档时，该函数返回 `undefined`；`undefined` 分支随后把整条消息渲染成单块暗色文本，这两个字段一个都不看。于是未能解析的上下文永久处于展开状态，且对 `Ctrl+O` 毫无反应。

解析器拒绝的真实上下文远多于该回退分支所暗示的范围。`workspace-context` 用 `<system-reminder>` 包裹指令，并且只转义 `</system-reminder>`，因此正文中任何裸的 `&` 或 `<` 都构成无效实体引用或非法标签，进而让整篇文档解析失败。徽章 URL 中的 `&logo=` 会触发这一情况，任何 `a < b` 也会。在一份真实会话日志中观察到：两张 `workspace-instructions` 卡片分别渲染出 254 行和 85 行，折叠态与展开态完全一致，且每张卡片正文首行都是字面量 `<system-reminder>`；而一张文本恰好能解析的 `dsh-tool-skill` 卡片则把 113 行折叠到了 46 行。

用户可见的症状看起来像两个缺陷——外框行又回来了，而且什么都折不起来——但两者都出自这同一个分支。

## 决策

折叠是卡片的属性，而非文本的属性。`preview` 从 `packages/ui/tui/src/components/xml-tool-output.ts` 导出，并在 `ContextCardComponent.render` 中作用于组装完成的正文。

`ToolCardComponent` 此前内联复制了那套头部／尾部／标记的行数计算；它现在调用同一个 `preview`，因此所有 transcript（文本记录）卡片的折叠规则由一个函数统一持有。对于工具卡片中已经逐子项折叠过的树形正文，再对组装完成的行施加一次限额是有意为之：逐子项的限额只约束单个子项，而非它们的总和，因此大量小子项仍可能超出卡片的限额。

本记录的修复保留了解析，并让折叠不再依赖解析结果。卡片[已完全不再解析上下文](2026-07-28-context-cards-render-prose-not-xml.md)，这同时也消除了本次修复无法抑制的残留外框行：未解析的正文没有可去掉的已解析根元素，因此其首行仍是字面量 `<system-reminder>`。

## 考虑过的替代方案

**在 `workspace-context` 中转义 `&` 与 `<`，使文档总能解析。** 作为本缺陷的修复方案不予采纳：它是靠让解析成功来让折叠生效，从而使折叠仍取决于内容。任何注入任意文本的其他插件，或任何转义遗漏，都会重新引入同一症状。这件事本身值得做——它还会顺带去掉外框行——但卡片无论如何都必须能折叠。

**先做预解析修复，或改用宽松的 HTML 式解析器。** 不予采纳：`renderUnknownXml` 是有意拒绝的，这样部分或混合文本才会原样渲染，而不是走一棵猜出来的树。为了满足呈现限额而放宽它，等于用一次正确的拒绝换来一棵错误的树，并且会连未知工具结果一起波及。

**只在 `undefined` 分支里做截断。** 不予采纳：它修掉了症状，却留下两份彼此一致性未经验证的折叠实现。导出 `preview` 同时消除了工具卡片中的那份重复。

## 后果

每张上下文卡片都会折叠到 `maxToolOutputLines`，并响应 `Ctrl+O`，无论其文本包含什么。树形正文含大量子项的工具卡片现在可能在原先不折叠的情况下折叠，因为受约束的是卡片总行数而非每个子项。

## 测试

`packages/ui/tui/tests/tui.spec.ts` 固定了一张文本带有裸 `&` 的上下文卡片（徽章 URL 中的 `&logo=`，即观察到的真实触发条件）：它默认处于折叠态并带有 `Ctrl+O to expand` 标记，隐藏了中间某一行，按下 `Ctrl+O` 后将其显示出来。该测试在本次修复的父提交上曾失败，当时的卡片不会输出标记。
