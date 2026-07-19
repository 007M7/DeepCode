# 开发一个 Tool

Tool 是模型可以调用的能力。本文介绍如何用 `defineTool` 编写一个 tool。

## 最小示例

```ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    async execute(args) {
      // args 自动推导为 { name: string }
      return [{ type: 'text', text: `Hello, ${args.name}!` }]
    },
  }))
}
```

## 参数定义

`parameters` 用一种简洁的格式描述参数，框架会自动转换为模型需要的 JSON Schema。

### 基本类型

```ts
import type { SchemaSpec } from '@deepseek-ai/dsh-tools'

const parameters = {
  path: { type: 'string', required: true },
  limit: { type: 'number' },
  recursive: { type: 'boolean' },
} satisfies SchemaSpec
// 推导类型: { path: string; limit?: number; recursive?: boolean }
```

### 枚举

```ts
import type { SchemaSpec } from '@deepseek-ai/dsh-tools'

const parameters = {
  mode: { type: 'string', required: true, enum: ['read', 'write', 'append'] },
} satisfies SchemaSpec
// 推导类型: { mode: string }  (运行时校验 enum 值)
```

### 嵌套对象

```ts
import type { SchemaSpec } from '@deepseek-ai/dsh-tools'

const parameters = {
  options: {
    type: 'object',
    properties: {
      timeout: { type: 'number' },
      retries: { type: 'number' },
    },
  },
} satisfies SchemaSpec
// 推导类型: { options?: { timeout?: number; retries?: number } }
```

### 数组

```ts
import type { SchemaSpec } from '@deepseek-ai/dsh-tools'

const parameters = {
  tags: {
    type: 'array',
    items: { type: 'string' },
  },
} satisfies SchemaSpec
// 推导类型: { tags?: string[] }
```

### 每个属性的字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'string' \| 'number' \| 'boolean' \| 'object' \| 'array'` | 值类型 |
| `required` | `true` | 标记为必填（影响类型推导） |
| `description` | `string` | 发送给模型的描述 |
| `enum` | `string[]` | 允许的枚举值 |
| `properties` | `SchemaSpec` | 嵌套属性（type 为 object 时） |
| `items` | `SchemaProp` | 数组元素 schema（type 为 array 时） |

## execute 函数

`execute` 接收经过校验的 `args`（类型自动推导）和一个 `exec` 上下文对象：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

defineTool({
  name: 'demo',
  description: 'Demo tool.',
  parameters: {},
  async execute(args, exec) {
    // args: 根据 parameters 自动推导的类型
    // exec: ToolExecution 对象，提供执行上下文

    // 返回 ContentBlock 数组
    return [{ type: 'text', text: 'result here' }]
  },
})
```

### 返回值

`execute` 必须返回一个 `ContentBlock[]`，告诉模型 tool 的执行结果：

```ts
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

declare const matchResults: string[]

// 文本结果
function textResult(): ContentBlock[] {
  return [{ type: 'text', text: 'file content here...' }]
}

// 多个 block
function multiBlockResult(): ContentBlock[] {
  return [
    { type: 'text', text: 'Found 3 matches:' },
    { type: 'text', text: matchResults.join('\n') },
  ]
}
```

### 参数校验

`defineTool` 在调用 `execute` 之前会自动校验模型生成的参数。如果参数不合法，会抛出 `ToolArgsError`，框架将其转换为 `isError` 结果返回给模型，让模型自行修正。

你不需要在 `execute` 里手动校验参数类型。

## 展示层 (Presentation)

Tool 可以定义 UI 渲染方法，用于在终端或 ACP 客户端中展示 tool call 和 result：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

defineTool({
  name: 'bash',
  description: 'Run a shell command.',
  parameters: {
    command: { type: 'string', required: true },
  },
  async execute(args) {
    return [{ type: 'text', text: `ran: ${args.command}` }]
  },
  presentCall(args) {
    return {
      card: 'terminal',
      title: args.command.slice(0, 60),
    }
  },
  presentResult(args, result) {
    return {
      card: 'terminal',
      output: result.content.map(b => b.type === 'text' ? b.text : '').join(''),
    }
  },
})
```

`presentCall` 和 `presentResult` 是**纯函数**，不能有副作用——UI 可能在流式传输中和会话回放中多次调用它们。

## 注册与卸载

`ctx.tools.register()` 返回值就是 disposer。但由于你在 `ctx` 上调用，框架已经自动追踪了这个注册——插件卸载时会自动移除 tool。你不需要手动调用 disposer。

```ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

declare const ctx: Context

// 这样就够了:
ctx.tools.register(defineTool({
  name: 'noop',
  description: 'Do nothing.',
  parameters: {},
  async execute() {
    return []
  },
}))

// 不需要:
// const dispose = ctx.tools.register(...)
// ctx.effect(() => dispose)
```

## 完整实战示例

一个文件计数 tool：

```ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir } from 'node:fs/promises'

export const name = 'file-counter'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'count_files',
    description: 'Count files in a directory.',
    parameters: {
      path: { type: 'string', required: true, description: 'Directory path' },
      extension: { type: 'string', description: 'Filter by extension (e.g. ".ts")' },
    },
    async execute(args) {
      const entries = await readdir(args.path, { withFileTypes: true })
      let files = entries.filter(e => e.isFile())
      if (args.extension) {
        files = files.filter(f => f.name.endsWith(args.extension!))
      }
      return [{ type: 'text', text: `Found ${files.length} files.` }]
    },
  }))
}
```

## 下一步

- [插件配置](config) — 让你的 tool 可配置
- [能力三件套](../practice/) — 了解 seam/impl/consumer 模式
