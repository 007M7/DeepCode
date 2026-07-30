# LLM 适配器

[English](llm-adapter.md) | 中文

本文介绍如何为 Harness 接入一个新的 LLM 提供方。

## 概述

LLM 适配器是一个继承 `LlmAdapter` 的类，实现 `stream()` 方法，将 Harness 的统一请求格式转换为具体 API 的调用。

## 最小实现

```ts
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class MyAdapter extends LlmAdapter {
  private apiKey: string

  constructor(apiKey: string) {
    super()
    this.apiKey = apiKey
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. Convert options.messages to the provider format.
    // 2. Call the streaming API.
    // 3. Convert the response into StreamChunk values.
  }
}

export interface Config {
  apiKey: string
  models: string[]
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required(),
  models: Schema.array(Schema.string()).required(),
})

export const name = 'my-llm-adapter'
export const inject = ['llm']

export function apply(ctx: Context, config: Config) {
  const adapter = new MyAdapter(config.apiKey)
  ctx.llm.registerAdapter(config.models, adapter)
}
```

## StreamChunk 协议

`stream()` 必须按以下协议 yield chunk：

```ts
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

async function* exampleChunks(): AsyncIterable<StreamChunk> {
  // 1. Start each content block with block-start.
  yield { type: 'block-start', index: 0, blockType: 'text' }

  // 2. Stream text through text-delta.
  yield { type: 'text-delta', index: 0, text: 'Hello' }
  yield { type: 'text-delta', index: 0, text: ' world' }

  // 3. End each content block with block-end and the complete block.
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'Hello world' },
  }

  // 4. Tool-call block.
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield {
    type: 'tool-call-delta',
    index: 1,
    id: CallId('call-123'),
    name: 'bash',
    argumentsDelta: '{"command":"ls"}',
  }
  yield {
    type: 'block-end',
    index: 1,
    block: {
      type: 'tool-call',
      id: CallId('call-123'),
      name: 'bash',
      arguments: '{"command":"ls"}',
    },
  }

  // 5. Token usage.
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }

  // 6. Finish reason.
  yield { type: 'finish', reason: { kind: 'stop' } }
  // Alternatively, { kind: 'tool-calls' } requests tool execution.
}
```

### 关键规则

- 每个 `block-start` 必须有对应的 `block-end`
- `index` 从 0 递增，标识内容块顺序
- `tool-call-delta` 的 `argumentsDelta` 是 JSON 字符串的增量（可以一次 yield 全部，也可以分多次）
- `finish` 必须是最后一个 chunk
- `usage` 在 `finish` 之前 yield

## GenerateOptions

`stream()` 接收仓库导出的 `GenerateOptions`。它包含模型名、由适配器持有的推理强度 ID、对话历史、系统提示词、tool schema、生成参数、停止序列和中止信号；完整字段以 `@deepseek-ai/dsh-llm` 导出的 TypeScript 类型为准。适配器必须将支持的字段映射到具体 API；无法支持的字段应抛出带稳定 code 的 `LlmError`，不能静默丢弃。

请覆写 `resolveModel(provider, model, signal?)`，在一次查询中返回确切的提供方/模型身份以及可选的 `context` 和 `reasoning` 元数据。推理元数据包含有序的不透明 ID、展示名称，以及可选的配置默认值；请保留适配器给出的权威可选列表，包括其上游能力 API 返回的 `off`，而不要将这些值提升为核心枚举。异步查询必须响应这个可选信号，让取消和资源释放都能达到完全停稳。服务会校验聚合结果，并在调用 `stream()` 前拒绝显式指定但不受支持的推理强度；省略 `reasoning` 表示该模型没有可选的推理强度能力。

## 注册适配器

```ts ignore-check
ctx.llm.registerAdapter(['model-name-1', 'model-name-2'], adapter)
```

第一个参数是该适配器支持的模型名列表。当用户在 `cordis.yml` 中配置 `model: model-name-1` 时，框架会路由到这个适配器。

## 在 cordis.yml 中使用

```yaml
- id: my-llm
  name: './src/my-llm-adapter.ts'
  config:
    apiKey: !!js process.env.MY_API_KEY
    models:
      - my-model-v1
      - my-model-v2

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: my-llm
    model: my-model-v1  # References the model registered above.
    workspaceContext: false
```

## 实战参考

仓库中有两个完整实现可供参考：

- `packages/llm/llm-deepseek/` — DeepSeek API 适配器（OpenAI 兼容格式）
- `packages/llm/llm-pi-ai/` — Pi AI 适配器（不同的 API 格式）

对比这两个已交付的适配器，可以看到同一套 harness 契约如何在不同提供方 SDK 之上实现。

## 错误处理

适配器应将传输和协议故障作为带稳定 code 的 `LlmError` 抛出；agent loop 会保留该错误及其 code，供诊断和策略使用。不要依赖普通 `Error` 被自动转换。每个提供方 HTTP 请求还必须合并 `attributionHeaders()`，并传递 `options.signal`。

```ts
import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

class HttpAdapter extends LlmAdapter {
  constructor(private readonly endpoint: string) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify({ model: options.model, messages: options.messages }),
      ...options.signal ? { signal: options.signal } : {},
    })
    if (!response.ok) {
      throw new LlmError(`Provider API error: ${response.status}`, 'PROVIDER_HTTP_ERROR')
    }
    // A real adapter parses the response and emits the complete chunk sequence.
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
```
