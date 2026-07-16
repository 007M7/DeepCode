# RFC：对提供方请求强制携带 `User-Agent` 归属标识

Status: implemented

[English](2026-06-21-mandatory-app-attribution-headers.md) | 中文

## 问题

LLM（大语言模型）提供方请求应当标识发出请求的产品。这对提供方侧的技术支持、滥用调查、兼容性调试和流量分析都有价值。在本 RFC 之前，harness 只部分做到了这一点：手写的 DeepSeek 适配器发送一个手动复制的 `User-Agent` 常量（`packages/llm/llm-deepseek/src/adapter.ts`），而基于 pi-ai 的孪生适配器完全不发送 harness 自有的头部（`packages/llm/llm-pi-ai/src/adapter.ts`）。因此新适配器可以静默地遗漏归属标识，而库封装的适配器也可能与手写适配器产生偏差——尽管[孪生适配器 RFC](2026-06-13-twin-llm-adapters.md) 的存在正是为了让两种实现在提供方 seam 上保持诚实。

直接触发点来自 OpenRouter 的 [App Attribution](https://openrouter.ai/docs/app-attribution) 文档。OpenRouter 通过 `HTTP-Referer` 加展示名/分类头部来创建应用页面和排名。这有价值，但它不是 HTTP 标准中的应用身份机制。风险在于：把 OpenRouter 的确切头部集合当作通用标准采纳，然后将提供方特定的头部泄漏到直连 DeepSeek 的请求、未来的 OpenAI/Anthropic/Vertex 适配器、测试服务器或无限期记录未知字段的代理中。

## 调研

- **OpenRouter 的机制是提供方特定的。** 其当前文档说明应用归属通过 `HTTP-Referer`（必需）、`X-OpenRouter-Title` 和 `X-OpenRouter-Categories` 追踪；`X-Title` 仅为向后兼容而接受。其 API 参考称这些头部为可选，并说它们使应用在 OpenRouter 上可被发现。这是一份具体的 OpenRouter 契约，而非 IETF 或 OpenAI 兼容 API 标准。
- **在 agent 工具领域，`HTTP-Referer` 是一种 OpenRouter 感知的约定，而非通用 agent 约定。** 它足够常见，以至于 OpenRouter SDK 和示例直接暴露它，面向 OpenRouter 的框架通常需要一种方式来透传它。但 ACP（Agent Client Protocol）等 agent 协议在自己的 initialize 消息中协商名称、版本和能力，而模型提供方请求仍需 HTTP 层面的身份标识。因此「在 agent 世界被接受」意味着「被 OpenRouter 集成所识别」，而非「可跨 agent 运行时或提供方移植」。
- **编程 agent 在 `User-Agent` 中标识产品和版本。** 公开实现在环境细节和提供方特定附加头部上各有不同，但产品身份是共同契约；不存在通用的精确格式。
- **标准化的通用客户端身份头部是 `User-Agent`。** RFC 9110 第 10.1.5 节将 `User-Agent` 定义为用户代理软件的身份标识，说明它用于互操作性报告和分析，并说用户代理应当（SHOULD）在每个请求中发送它，除非被配置为不发送。这是唯一直接匹配「哪个产品在发出这个 HTTP 请求」的标准头部。
- **`Referer` 是标准的，但 OpenRouter 的 `HTTP-Referer` 不是标准字段。** RFC 9110 第 10.1.3 节将 `Referer` 定义为获取目标 URI 的来源 URI，并用大量篇幅讨论隐私限制。OpenRouter 则要求 `HTTP-Referer`，将其用作应用 URL 标识符。该名称和含义是 OpenRouter 特有的，尽管它形似标准 `Referer` 头部的 CGI 环境变量形式。
- **`From` 是标准的，但不适合作为强制默认。** RFC 9110 第 10.1.2 节将 `From` 定义为负责用户代理的人类的电子邮件地址。机器人代理应当（SHOULD）发送它以便服务器联系运营者，但非机器人代理不应在没有用户显式配置的情况下发送它，因为存在隐私和安全策略顾虑。harness 可以后续支持运营者联系方式，但不得凭空编造或全局强制要求。
- **请求体中的 `user` 或 `metadata` 字段不是应用归属。** 某些模型 API 暴露稳定的终端用户标识符、请求元数据、标签或项目/账户头部。这些对滥用监控、内部计费、仪表盘或链路追踪有用，但它们要么标识的是终端用户而非产品，要么是提供方特定的 body schema，要么不保证能通过 OpenAI 兼容网关转发。它们不能替代静态的应用身份头部。
- **SDK 遥测头部标识的是 SDK，而非应用。** 官方和第三方 SDK 经常发送库/版本头部。这些帮助 SDK 维护者调试客户端，但除非应用显式提供产品归属层，否则它们不会将 harness 标识为应用。
- **pi-ai 有一流的头部钩子。** `@earendil-works/pi-ai` 的 `StreamOptions.headers` 将调用方头部最后合并（覆盖提供方默认值），因此库封装的适配器无需包装或上游改动即可满足与手写适配器相同的协议格式（wire format）契约。mock 服务器测试套件对两个适配器都断言头部到达了线路。

## 决策

在 LLM 适配器边界，提供方请求归属是强制的，且仅使用标准 `User-Agent` 头部。规则是：每个产品 LLM 适配器在每个提供方 HTTP 请求上发送一个静态、非机密的应用身份，且每个适配器都有测试证明 `User-Agent` 到达了线路（mock 服务器断言收到的头部；对于库封装的适配器，库的头部钩子喂入同一个 mock 服务器断言）。

本 RFC **不**实现 OpenRouter 应用归属。`HTTP-Referer`、`X-OpenRouter-Title`、`X-Title` 和 `X-OpenRouter-Categories` 是 OpenRouter 特定的产品展示头部，不是提供方无关的模型请求归属。它们可以后续由 OpenRouter 适配器或显式 OpenRouter 模式提出，带有自己的隐私/产品决策、测试和文档。在那之前，即使请求指向 OpenRouter，也只发送本 RFC 的共享 `User-Agent` 归属。

提供方无关的身份由 `dsh-llm`（`packages/llm/llm/src/attribution.ts`）拥有，而非各个适配器。`AppIdentity` 仅包含构建 `User-Agent` 所需的公开产品事实，默认的 `APP_IDENTITY` 确定了提案中留待决定的值：

- `User-Agent` 的产品令牌：`deepseek-harness`（与 RFC 之前的线路值以及仓库/组织身份保持连续性）
- 版本：通过 `createRequire` 从所属包的 manifest（元数据清单）读取，绝不手动复制常量
- 应用 URL：`https://github.com/deepseek-ai/deepseek-harness-sdk`——计划中的公开主页；`attribution.ts` 中的 `FIXME` 阻塞发布，直到该仓库实际存在

默认值是强制的且非空。白标部署向 `attributionHeaders(identity)` 传入自己的 `AppIdentity`——覆盖 seam 就是函数参数，在有消费方需要之前不做部署配置管道——省略时回退到 harness 默认值而非抑制归属。没有逐请求 API 让模型、用户提示词、会话 id、cwd、用户邮箱、API key 所有者或本地机器身份影响这些字段。

线路映射（`attributionHeaders`；代码中头部名称为小写——HTTP 字段名在线路上不区分大小写）：

| 目标 | 映射 |
|---|---|
| 所有基于 HTTP 的适配器 | `User-Agent: {product}/{version} (+{url})`——括号中的 `+url` 注释符合 RFC 9110 保守的 product/comment 语法。 |
| 直连 DeepSeek 端点 | `User-Agent`；除非 DeepSeek 文档记录了等效契约，否则不发送 OpenRouter 专用头部。 |
| OpenRouter 端点 | 目前仅 `User-Agent`。本 RFC 下不发送 `HTTP-Referer`、`X-OpenRouter-Title`、`X-Title` 或 `X-OpenRouter-Categories`。 |
| 未来提供方 | 仅 `User-Agent`，除非后续提供方特定 RFC 接受额外头部。不以类推方式复用 `HTTP-Referer`。 |

端点检测不属于本 RFC，因为此处不接受任何端点特定映射。如果后续落地 OpenRouter 支持，检测必须是显式的：要么是专用的 OpenRouter 提供方包，要么是显式的 `provider: 'openrouter'` / `attributionTarget: 'openrouter'` 配置，而非任意路径片段或模型名。

## 验证

已落地的契约：

- `dsh-llm` 为 `LlmAdapter` 作者记录了强制的 `User-Agent` 归属契约（`LlmAdapter` JSDoc、包 README，以及 `docs/core-data-structures/llm-streaming.md` 的适配器契约章节）。
- 共享辅助函数（`attributionHeaders` / `userAgent`）从包元数据构建应用身份和标准 `User-Agent` 值，适配器无需手动复制版本常量。
- `dsh-llm-deepseek` 在每个请求上发送共享的 `User-Agent`，其 mock 服务器套件断言精确值。
- `dsh-llm-pi-ai` 通过 pi-ai 的 `StreamOptions.headers` 钩子发送相同的 `User-Agent`，其 mock 服务器套件断言精确值。
- 本 RFC 下没有适配器发送 OpenRouter 特定的归属头部（`HTTP-Referer`、`X-OpenRouter-Title`、`X-Title`、`X-OpenRouter-Categories`）。
- 没有应用归属字段携带机密、本地路径、会话 id、提示词文本、模型输出、用户邮箱或逐用户稳定标识符。
- 适配器 README 声明了 `User-Agent` 归属策略，并明确避免将 OpenRouter 应用归属记录为已实现行为。

## 曾考虑的替代方案

**现在就实现 OpenRouter 应用归属。** 本 RFC 否决。发送 `HTTP-Referer` 加 `X-OpenRouter-Title` 可以满足 OpenRouter 排名，但这些头部是提供方特定的产品功能，不是本 RFC 试图标准化的提供方无关模型请求归属。支持它们应当是后续显式的 OpenRouter 适配器/模式决策，而非隐藏在第一个共享归属辅助函数中。

**所有地方都发 OpenRouter 头部。** 否决。这会把一份自定义 OpenRouter 契约当作通用标准，并向未要求这些字段的提供方发送语义误导的字段。还有风险把 `HTTP-Referer` 当作通用应用 URL 字段使用，尽管标准 HTTP 已有 `User-Agent` 用于产品身份、`Referer` 用于不同的浏览上下文概念。

**仅使用提供方账户/项目身份。** 否决。组织/项目头部、API key、云账户和计费项目标识的是谁付费或谁拥有请求，而非哪个应用在发送流量。它们也不暴露公开的应用标题/分类，不帮助 OpenRouter 等网关构建应用排名。

**终端用户 `user`/`metadata` 字段。** 本 RFC 否决。这些对滥用监控和客户支持有价值，但描述的是请求背后的人或租户。应用归属必须是静态产品身份，且可安全地在每个请求上发送。

**仅配置 opt-in 的归属。** 否决。默认关闭的设置正是适配器持续漂移的原因。策略是强制默认归属加可覆盖的公开值，而非可选归属。

**以产品命名的令牌（`deepseek-harness-sdk`）。** 曾考虑用于 `User-Agent` 令牌，因为产品名是 DeepSeek Harness SDK。`deepseek-harness` 以连续性胜出：它是提供方已经从本代码库看到的身份，与组织/仓库身份和包作用域一致，且在展示文案承载产品名的同时保持线路归属稳定。

## 后果

**提供方看到流量来自 harness。** 这正是目的，但意味着此前混入通用 SDK 流量的部署变得可识别。缓解措施：仅发送静态公开产品数据，并允许 fork/白标部署传入自己的 `AppIdentity`。

**应用 URL 指向一个尚不存在的仓库。** `deepseek-ai/deepseek-harness-sdk` 是计划中的公开主页；在创建之前该 URL 是一个悬空承诺。常量上的 `FIXME` 标记阻塞发布，使其不会在未解决的情况下发版（见 `docs/development.md` 标记语义）。

**不同客户端库的头部支持有差异。** 手写适配器直接设置头部；pi-ai 封装的适配器依赖 pi-ai 继续遵守 `StreamOptions.headers`（最后合并覆盖提供方默认值）。线路级 mock 服务器测试是守卫：如果 pi-ai 升级后不再投递该头部，套件变红。这对抽象层是有益的压力：一个无法设置强制头部的提供方适配器无法完整实现 harness 的 LLM 契约。

**OpenRouter 排名尚未受益。** `User-Agent` 是提供方无关 HTTP 身份的正确基线，但它不会创建 OpenRouter 应用页面或排名，因为 OpenRouter 要求 `HTTP-Referer` 才能实现该产品功能。这是有意为之：公开应用市场参与是一个独立的产品决策，不是强制请求归属的前提。
