# LLM (dsh-llm)

LLM 服务接口和适配器注册。

**包名:** `@deepseek-ai/dsh-llm`
**服务名:** `ctx.llm`

## LLM Service

### ctx.llm.registerAdapter(models, adapter)

- **models:** `string[]` 该适配器支持的模型名列表
- **adapter:** `LlmAdapter` 适配器实例
- **返回值:** `() => void` disposer

注册一个 LLM 适配器。当请求中指定的模型名在 `models` 列表中时，路由到该适配器。

```typescript
ctx.llm.registerAdapter(['deepseek-v4-flash', 'deepseek-v4-pro'], adapter)
```

## LlmAdapter

适配器基类。子类必须实现 `stream()` 方法。

### stream(options)

- **options:** `GenerateOptions`
- **返回值:** `AsyncIterable<StreamChunk>`

将统一请求格式转换为具体 API 的流式调用。

## GenerateOptions

```typescript
interface GenerateOptions {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  system?: string
  maxTokens?: number
  temperature?: number
}
```

| 字段 | 说明 |
|------|------|
| `model` | 请求的模型名 |
| `messages` | 对话历史 |
| `tools` | 当前可用的 tool 列表（JSON Schema 格式） |
| `system` | 系统提示词 |
| `maxTokens` | 最大输出 token |
| `temperature` | 采样温度 |

## StreamChunk

流式响应的增量 chunk 类型：

```typescript
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
```

### 协议规则

1. 每个内容块以 `block-start` 开始，以 `block-end` 结束
2. `index` 从 0 递增
3. `text-delta` 只在 `blockType: 'text'` 的块中
4. `tool-call-delta` 只在 `blockType: 'tool-call'` 的块中
5. `usage` 在 `finish` 之前
6. `finish` 必须是最后一个 chunk

## CallId

Tool call 的 opaque branded ID：

```typescript
import { CallId } from '@deepseek-ai/dsh-llm'

const id = CallId('call-abc123')
```

## TokenUsage

```typescript
interface TokenUsage {
  inputTokens: number
  outputTokens: number
}
```

## FinishReason

```typescript
type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
```

## Message

对话消息类型：

```typescript
interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}
```

## ContentBlock

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: CallId; name: string; arguments: string }
  | { type: 'tool-result'; callId: CallId; content: ContentBlock[]; isError?: boolean }
```
