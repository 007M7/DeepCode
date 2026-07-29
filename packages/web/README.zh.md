# web/ - web 能力家族

[English](README.md) | 中文

web 访问能力 seam：抽象 web 接口、搜索／抓取提供方实现，以及面向模型的 web 工具。这些全是**产品**包（package）。

| 包 | 职责 | ctx key |
|---|---|---|
| `web/` | 抽象 web seam（搜索／抓取提供方注册表 + 选择 + 词汇 + `WebError`） | `ctx.web` |
| `web-search-exa/` | Exa 支持的 `WebSearchProvider` | （注册到 `ctx.web`） |
| `web-search-perplexity/` | Perplexity 支持的 `WebSearchProvider` | （注册到 `ctx.web`） |
| `web-search-deepseek/` | DeepSeek 支持的 `WebSearchProvider`，通过 Anthropic 兼容 API 使用原生 `web_search` | （注册到 `ctx.web`） |
| `web-fetch-local/` | 用于匿名访问公共 HTTP(S) 的 `WebFetchProvider` | （注册到 `ctx.web`） |
| `tool-web/` | 面向模型的 `web_search`／`web_fetch` 工具 schema | （注册到 `ctx.tools`） |

接口位于 `web/web/`。与 bash/fs 不同，该 seam 跨越**两种能力**（搜索和抓取），每种能力都可能有多个提供方：`ctx.web` 是单一的 web 访问中间层，拥有一项提供方选择策略、一套中止／错误词汇，以及一个面向产品的「该 harness 如何访问 web」配置接口。提供方注册的是**能力**而非工具；`tool-web` 是面向模型名称、schema、提示词指引和呈现的唯一负责方。替换搜索提供方不会改变模型提出查询的方式，替换抓取实现也不会改变模型请求 URL 的方式。

设计原理见 [web 能力 seam Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)，其中也解释了搜索与抓取为何有意合并为一个 seam，以及为何暂缓实现 `web_fetch` 的 SSRF 防护。
