# Build a tool

English | [中文](tool.zh.md)

A tool is a capability the model can call. This guide builds one with `defineTool`.

## Minimal example

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

## Parameter definitions

`parameters` uses a compact format that the framework converts to the JSON Schema sent to the model.

### Primitive types

```ts
export const parameters = {
  path: { type: 'string', required: true },
  limit: { type: 'integer' },
  recursive: { type: 'boolean' },
  parent: { type: 'null' },
}
// Inferred type: { path: string; limit?: number; recursive?: boolean; parent?: null }
```

### Enums

```ts
export const parameters = {
  mode: { type: 'string', required: true, enum: ['read', 'write', 'append'] },
}
// Inferred type: { mode: 'read' | 'write' | 'append' }
```

### Nested objects

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

### Arrays

```ts
export const parameters = {
  tags: {
    type: 'array',
    items: { type: 'string' },
  },
}
// Inferred type: { tags?: string[] }
```

### Property fields

| Field | Type | Meaning |
|------|------|------|
| `type` | `'string' \| 'number' \| 'integer' \| 'boolean' \| 'null' \| 'object' \| 'array' \| 'json'` | Value type; `json` accepts any lossless JSON value |
| `required` | `true` | Marks the property required and affects inference |
| `description` | `string` | Description sent to the model |
| `enum` / `const` | matching scalar values | Allowed literal values, checked at author and runtime boundaries |
| `properties` | `ParameterSchemaSpec` | Nested properties for an object |
| `additionalProperties` | `true \| false` | Required on every explicit object node |
| `items` | `ValueSchemaSpec` | Element schema for an array |
| `oneOf` | at least two `ValueSchemaSpec` branches | Requires exactly one matching branch; used instead of `type` |

The outer `parameters` map is an implicit open object. Explicit nested objects choose their openness; raw JSON Schema registered without `defineTool` keeps JSON Schema's open-by-default behavior.

## The execute function

`execute` receives validated, inferred `args` and an `exec` execution context:

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

### Return value

`execute` returns the lossless JSON value declared by `output.schema`. `output.render(args, value)` separately turns that validated value into the Native/model-facing content:

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

The canonical value is available to execution-time programmatic callers and is not persisted in `tool/result`; the rendered content and optional `presentationMeta` are the replayable projections. A body value that does not satisfy the schema, or is not lossless JSON, becomes an `INVALID_TOOL_OUTPUT` failure.

### Argument validation

Before calling `execute`, `defineTool` validates model-generated arguments. Invalid input raises `ToolArgsError`; the framework turns it into an `isError` result so the model can correct its call.

Do not repeat type validation inside `execute`.

## Presentation

A tool can define transport-neutral presentation methods for terminal and web clients:

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

`presentCall` and `presentResult` are **pure functions**. Streaming UI and session replay may call them more than once.

## Registration and unloading

`ctx.tools.register()` returns a disposer, but a registration made through `ctx` is already tracked by the framework. Unloading the plugin removes the tool automatically, so the plugin does not call the disposer itself.

```ts ignore-check
// This is sufficient:
ctx.tools.register(defineTool({ /* ... */ }))

// No saved disposer or extra cleanup registration is needed.
```

## Complete example

This tool counts files in a directory:

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

## Next steps

- [Plugin configuration](./config.md) — make the tool configurable
- [Capability layering](../practice/) — understand the interface/implementation/consumer pattern
