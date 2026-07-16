# RFC：裁剪 web seam 中未使用的字段

Status: implemented

[English](2026-07-12-prune-unused-web-seam-fields.md) | 中文

## 问题

web 能力携带了一组 request/result/status 值，每个已交付的实现都填充了它们，但没有生产消费方读取。`WebSearchResult.providerId`、`query` 和 `WebFetchResult.providerId` 是结果回显；`tool-web` 只格式化 content/sources/truncation 或 final URL/status/body/truncation，其他运行时也不读取这些字段。搜索提供方返回 `WebProviderStatus.reason`，但可用性检查只看 `available`，并有意输出一条通用的不可用诊断。

`WebFetchRequest.timeoutMs` 同样没有生产调用方设置。`tool-web` 只提供 URL，用工具定义的超时加 `exec.signal` 作为调用方截止时间，并依赖本地提供方的配置默认值作为兜底。这个未使用的按请求超时覆盖迫使 `web-fetch-local` 暴露 `maxTimeoutMs`、钳位两个超时源，并为没有产品路径能选中的优先级规则编写文档和测试。`WebExecContext` 则是另一个单字段包装层：每个调用方分配 `{ signal }`，每个提供方立即解包 `exec?.signal`；不存在第二个执行控制字段。

## 决策

web seam 省略搜索/抓取的 `providerId` 结果回显和搜索 `query` 回显；调用方本身已持有请求和提供方选择信息。提供方以返回布尔值的方法暴露可用性。抓取请求不再有按请求超时或 `maxTimeoutMs` 钳位；本地提供方保留其可配置的默认超时，工具保留自身的截止时间。提供方方法接收一个直接的可选 `AbortSignal`，而非单字段的 `WebExecContext` 包装层。

所有 web 实现和面向模型的工具使用更小的契约。接口/实现/消费方的包拆分、提供方选择、来源引用、最终 URL/状态数据、截断报告与安全限制保持不变。

## 曾考虑的替代方案

**保留自描述结果、按请求截止时间和可扩展的执行上下文对象。** 结果回显可以帮助通用遥测，请求超时可以帮助受信的编程调用方，包装层对象为未来的控制留出空间。但这样的消费方或第二字段并不存在；在每个提供方中携带重复的身份信息、第二套截止时间策略以及包装/解包管道，使当前契约更难实现和解释。如果遥测或按调用的预算控制到来，它应当定义哪个截止时间获胜、在哪里观测提供方身份，以及多个控制是否足以证明上下文对象的存在。

## 后果

保留下来的每个 web request/result 字段都被生产代码消费或为执行提供方请求所必需。工具可见的搜索/抓取输出、提供方回退、中止行为、配置的超时兜底、截断与引用仍被覆盖，无需请求超时优先级分支或执行上下文包装层。

预发布的编程调用方失去结果来源回显和按请求的抓取截止时间。提供方仍有部署可配置的超时并尊重取消信号，因此这次精简移除的是可配置性而非安全边界。
