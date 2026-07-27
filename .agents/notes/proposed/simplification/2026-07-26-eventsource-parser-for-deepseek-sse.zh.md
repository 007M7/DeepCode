# Agent Note: 用 eventsource-parser 替换 llm-deepseek 中手写的 SSE 解析器

Status: proposed

[English](2026-07-26-eventsource-parser-for-deepseek-sse.md) | 中文

## 问题

`packages/llm/llm-deepseek/src/sse.ts` 手写实现了 SSE（Server-Sent Events）解析：一个流式 `TextDecoder`、按 `\r?\n\r?\n` 切分事件块、提取并拼接 `data:` 载荷、跳过注释与其他字段、`[DONE]` 哨兵、在未见哨兵即 EOF 时抛出 `STREAM_CLOSED` 错误，以及对最后一个未终结事件块的 flush。该文件约 67 行，另有约 108 行专属测试（`tests/sse.spec.ts`）重复验证 SSE 规范行为——UTF-8 字符被切分到多个分片、CRLF 处理、多条 `data:` 拼接、冒号后无空格——而这些行为，持续维护的解析器早已有保证。它唯一的消费方是 `adapter.ts`（`yield* translate(parseSse(response.body))`）。

这恰好是 `eventsource-parser` 负责的接口面：事实标准的 SSE 解析器（Vercel AI SDK 和 MCP SDK 都构建在它之上），零依赖，持续维护，并且已通过 `@modelcontextprotocol/sdk` 作为传递依赖出现在本仓库的 lockfile 中——因此直接采用它实际上不增加新的供应链接触面。

## 提案

用 `eventsource-parser/stream` 的 `EventSourceParserStream` 替换 `sse.ts`：`response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())`，只保留 DeepSeek 协议垫层（约 10–25 行）：逐个产出事件的 `data`，遇到 `[DONE]` 终止，流在未见哨兵时结束则抛出 `LlmError('STREAM_CLOSED')`。所需的全部内置能力（`TextDecoderStream`、`pipeThrough`、可异步迭代的 `ReadableStream`）在 Node ^22.19 引擎下限即已存在。删除规范符合性测试；保留 `[DONE]`/`STREAM_CLOSED`/EOF 契约测试。将 `eventsource-parser` 加入 `llm-deepseek` 的依赖（这是它继 schemastery 之后的第二个运行时依赖）。在同一个 PR（Pull Request）中更新[孪生适配器 Agent Note（agent 决策记录）](../../implemented/architecture/2026-06-13-twin-llm-adapters.md)以及 `dsh-llm` 中把该适配器标为「手写 fetch + SSE 解析」的 JSDoc。

该库还会剥离开头的 BOM（手写解析器在 BOM 之后会无法匹配 `data:`），并提供当前解析器缺少的 `maxBufferSize` 加固能力。

## 曾考虑的替代方案

- **保留手写解析器。** 依据[孪生适配器决策](../../implemented/architecture/2026-06-13-twin-llm-adapters.md)，这一选择有辩护余地：该适配器有意作为 pi-ai 适配器的手写设计验证孪生体。但那份 Agent Note 起支撑作用的区分在于「自行持有 fetch/translate 内部实现」与「委托给完整的提供方 SDK」；一个约 700 字节的 SSE 微型解析器属于传输层管道，不是被验证的设计本身。这一解读是否成立由孪生 Agent Note 的所有者裁定——本提案明确需要其签署确认。
- **改用 `createParser({onEvent})` 回调 API 而非流。** 配合手动的 `TextDecoder` 循环可以工作，但 `pipeThrough` 组合方式能删除更多手写代码。

## 验收标准

- `sse.ts` 的解析内部实现消失；剩下的垫层只编码 DeepSeek 的 `[DONE]`/`STREAM_CLOSED` 协议。
- `llm-deepseek` 单元测试与真实 API 的 e2e 套件通过；无密钥快照不变（解析属于传输层内部，载荷提取等价）。
- 孪生适配器 Agent Note 与 `dsh-llm` 的 JSDoc 不再声称手写 SSE 解析。

## 风险

- 会失去一处有意为之的健壮性偏离：手写解析器会 flush 缺少终结空行的最后一个事件块，`tests/sse.spec.ts` 固定了「末尾的 `data: [DONE]` 即使没有 `\n\n` 也仍产出 DONE」这一行为。eventsource-parser 严格遵循规范，只在空行处分发事件，因此这种形态会变成 `STREAM_CLOSED`。真实提供方和 `dsh-llm-mock-server` 总是正确终结事件，所以被固定的行为只是健壮性上的锦上添花，并非实际观测到的提供方形态：可以删除该测试；若判定该偏离确有支撑作用，也可以保留一个小型的缓冲区尾部检查。
- 稀释了孪生适配器有文档记录的「手写」身份；缓解方式是在同一次变更中更新那份 Agent Note，而不是让声明陈旧下去。
