# 事后分析

[English](README.md) | 中文

事故记录：一个 bug 到达了它不该到达的地方（真实用户、已合并的 PR（Pull Request）、已发布的版本），有意义的部分是**为什么我们的流程放过了它**，而不仅仅是那行修复。

事后分析不是 [RFC](../rfc/README.md)（RFC 记录的是经过深思熟虑的设计决策及其被否决的替代方案，或提出未来工作）。它是一份面向过去的失败记录：什么坏了、机制是什么、为什么每道安全网都没拦住、以及加了哪些具体护栏使同类 bug 下次能快速失败。

满足以下条件时写一篇：bug **隐蔽**（机制不显而易见，一位细心的工程师也得费力重新推导）、**系统性**（逃逸的原因是测试/工具/约定的缺口，而非一次性手误）、**重新发现的代价高**（它消耗了真实的调试时间，而且下次还会）。请链接该事后分析所推动建立的护栏（测试、AGENTS.md 规则、ADR）。

每篇事后分析以一段 **Executive summary** 开头：一段简短的文字，让忙碌的读者在三十秒内了解全貌——什么坏了、用通俗语言说的根因、为什么逃逸了、以及持久的教训——之后再展开详细的 Summary / Timeline / Root cause / Guardrails 各节。

| # | 标题 |
|---|---|
| [0001](0001-acp-default-export-drops-inject.md) | ACP server crashed on connect: `export default` dropped the plugin's `inject` |
| [0002](0002-js-expression-disabled-filesystem-tools.md) | Filesystem snapshot tools were permanently disabled by a literal `!!js` object |
