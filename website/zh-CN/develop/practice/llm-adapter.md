# LLM 适配器

本文介绍如何为 Harness 接入一个新的 LLM 提供方。

## 概述

LLM 适配器是一个继承 `LlmAdapter` 的类，实现 `stream()` 方法，将 Harness 的统一请求格式转换为具体 API 的调用。

## 最小实现

```ts
import type { Context } from 'cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class MyAdapter extends LlmAdapter {
  private apiKey: string

  constructor(apiKey: string) {
    super()
    this.apiKey = apiKey
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. 将 options.messages 转换为你的 API 格式
    // 2. 调用 API（流式）
    // 3. 将 API 响应转换为 StreamChunk 序列
  }
}

export interface Config {
  apiKey: string
  models: string[]
}

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

async function* demo(): AsyncIterable<StreamChunk> {
  // 1. 每个内容块以 block-start 开始
  yield { type: 'block-start', index: 0, blockType: 'text' }

  // 2. 文本块使用 text-delta
  yield { type: 'text-delta', index: 0, text: 'Hello' }
  yield { type: 'text-delta', index: 0, text: ' world' }

  // 3. 每个内容块以 block-end 结束（携带完整 block）
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'Hello world' },
  }

  // 4. Tool call 块
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

  // 5. Token 用量
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }

  // 6. 结束原因
  yield { type: 'finish', reason: { kind: 'stop' } }
  // 或: { kind: 'tool-calls' } 表示模型想调用 tool
}
```

### 关键规则

- 每个 `block-start` 必须有对应的 `block-end`
- `index` 从 0 递增，标识内容块顺序
- `tool-call-delta` 的 `argumentsDelta` 是 JSON 字符串的增量（可以一次 yield 全部，也可以分多次）
- `finish` 必须是最后一个 chunk
- `usage` 在 `finish` 之前 yield

## GenerateOptions

`stream()` 接收的请求包含：

```ts
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

declare const options: GenerateOptions

options.model        // 模型名
options.messages     // 对话历史 (Message[])
options.tools        // 可用的 tool schema 列表 (ToolSchema[])
options.system       // 系统提示词
options.maxTokens    // 最大输出 token
options.temperature  // 温度
options.signal       // 取消信号（必须响应）
```

你的适配器需要将这些映射到具体 API 的参数。

## 注册适配器

```ts
import type { Context } from 'cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

declare const ctx: Context
declare const adapter: LlmAdapter

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

- id: stdio-agent
  name: '@deepseek-ai/dsh-stdio-demo'
  config:
    model: my-model-v1  # 引用上面注册的模型名
```

## 实战参考

仓库中有两个完整实现可供参考：

- `packages/llm/llm-deepseek/` — DeepSeek API 适配器（OpenAI 兼容格式）
- `packages/llm/llm-pi-ai/` — Pi AI 适配器（不同的 API 格式）
- `examples/echo-agent/src/mock-llm.ts` — 最简 mock 适配器（教学用）

mock 适配器是学习 StreamChunk 协议的最佳起点——它用纯本地逻辑演示了完整的 chunk 序列。

## 错误处理

适配器中的异常会被 agent-loop 捕获并转化为 `LlmError`，告知上层。不需要在 `stream()` 内部做错误恢复——让异常冒泡即可。

```ts
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class HttpAdapter extends LlmAdapter {
  private endpoint = 'https://api.example.com/v1/chat'

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = await fetch(this.endpoint, { method: 'POST' })
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`)
    }
    // ... 正常流式处理
  }
}
```
