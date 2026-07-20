# 开发一个 Tool

[English](tool.md) | 中文

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
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // args is inferred as { name: string }.
      return `Hello, ${args.name}!`
    },
  }))
}
```

## 参数定义

`parameters` 用一种简洁的格式描述参数，框架会自动转换为模型需要的 JSON Schema。

### 基本类型

```ts
export const parameters = {
  path: { type: 'string', required: true },
  limit: { type: 'integer' },
  recursive: { type: 'boolean' },
  parent: { type: 'null' },
}
// Inferred type: { path: string; limit?: number; recursive?: boolean; parent?: null }
```

### 枚举

```ts
export const parameters = {
  mode: { type: 'string', required: true, enum: ['read', 'write', 'append'] },
}
// Inferred type: { mode: 'read' | 'write' | 'append' }
```

### 嵌套对象

```ts
export const parameters = {
  options: {
    type: 'object',
    additionalProperties: true,
    properties: {
      timeout: { type: 'number' },
      retries: { type: 'number' },
    },
  },
}
// The declared fields are inferred; additional JSON-valued keys are allowed.
```

### 数组

```ts
export const parameters = {
  tags: {
    type: 'array',
    items: { type: 'string' },
  },
}
// Inferred type: { tags?: string[] }
```

### 每个属性的字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'string' \| 'number' \| 'integer' \| 'boolean' \| 'null' \| 'object' \| 'array' \| 'json'` | 值类型；`json` 接受任意无损 JSON 值 |
| `required` | `true` | 标记为必填（影响类型推导） |
| `description` | `string` | 发送给模型的描述 |
| `enum` / `const` | 匹配类型的标量值 | 允许的字面量值，在编写和运行时边界校验 |
| `properties` | `ParameterSchemaSpec` | 对象的嵌套属性 |
| `additionalProperties` | `true \| false` | 每个显式对象节点都必须声明 |
| `items` | `ValueSchemaSpec` | 数组的元素 schema |
| `oneOf` | 至少两个 `ValueSchemaSpec` 分支 | 要求恰好匹配一个分支；代替 `type` 使用 |

外层 `parameters` 映射是一个隐式的开放对象。显式嵌套对象需自行选择是否开放；不通过 `defineTool` 注册的原始 JSON Schema 保持 JSON Schema 的默认开放语义。

## execute 函数

`execute` 接收经过校验的 `args`（类型自动推导）和一个 `exec` 上下文对象：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export const tool = defineTool({
  name: 'example',
  description: 'Return an example result.',
  parameters: {},
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    // args: inferred from parameters
    // exec: ToolExecution context

    // Return the value declared by output.schema.
    void args
    void exec
    return 'result here'
  },
})
```

### 返回值

`execute` 返回由 `output.schema` 声明的无损 JSON 值。`output.render(args, value)` 会将经过校验的值另外转换为 Native／模型可见的内容：

```ts ignore-check
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.content }],
},
async execute(args) {
  return { path: args.path, content: await readFile(args.path, 'utf8') }
}
```

执行期间的程序化调用方可以使用规范值，但 `tool/result` 不会持久化该值；渲染后的内容和可选的 `presentationMeta` 才是可回放的投影。工具主体返回的值若不满足 schema 或不是无损 JSON，就会变为 `INVALID_TOOL_OUTPUT` 失败。

### 参数校验

`defineTool` 在调用 `execute` 之前会自动校验模型生成的参数。如果参数不合法，会抛出 `ToolArgsError`，框架将其转换为 `isError` 结果返回给模型，让模型自行修正。

你不需要在 `execute` 里手动校验参数类型。

## 展示层 (Presentation)

Tool 可以定义 UI 渲染方法，用于在终端或 ACP 客户端中展示 tool call 和 result：

```ts ignore-check
defineTool({
  name: 'bash',
  // ...
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  presentCall(args) {
    return {
      card: 'terminal',
      title: args.command,
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

```ts ignore-check
// This is sufficient:
ctx.tools.register(defineTool({ /* ... */ }))

// No saved disposer or extra cleanup registration is needed.
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
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Found ${value.count} files.` }],
    },
    async execute(args) {
      const entries = await readdir(args.path, { withFileTypes: true })
      let files = entries.filter(e => e.isFile())
      if (args.extension) {
        files = files.filter(f => f.name.endsWith(args.extension!))
      }
      return { count: files.length, files: files.map(file => file.name) }
    },
  }))
}
```

## 下一步

- [插件配置](./config.md) — 让你的 tool 可配置
- [能力三件套](../practice/) — 了解 seam/impl/consumer 模式
