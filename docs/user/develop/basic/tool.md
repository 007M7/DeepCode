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
    async execute(args) {
      // args is inferred as { name: string }.
      return [{ type: 'text', text: `Hello, ${args.name}!` }]
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
  limit: { type: 'number' },
  recursive: { type: 'boolean' },
}
// Inferred type: { path: string; limit?: number; recursive?: boolean }
```

### Enums

```ts
export const parameters = {
  mode: { type: 'string', required: true, enum: ['read', 'write', 'append'] },
}
// Inferred type: { mode: string } (enum values are validated at runtime)
```

### Nested objects

```ts
export const parameters = {
  options: {
    type: 'object',
    properties: {
      timeout: { type: 'number' },
      retries: { type: 'number' },
    },
  },
}
// Inferred type: { options?: { timeout?: number; retries?: number } }
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
| `type` | `'string' \| 'number' \| 'boolean' \| 'object' \| 'array'` | Value type |
| `required` | `true` | Marks the property required and affects inference |
| `description` | `string` | Description sent to the model |
| `enum` | `string[]` | Allowed string values |
| `properties` | `SchemaSpec` | Nested properties for an object |
| `items` | `SchemaProp` | Element schema for an array |

## The execute function

`execute` receives validated, inferred `args` and an `exec` execution context:

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export const tool = defineTool({
  name: 'example',
  description: 'Return an example result.',
  parameters: {},
  async execute(args, exec) {
    // args: inferred from parameters
    // exec: ToolExecution context

    // Return a ContentBlock array.
    void args
    void exec
    return [{ type: 'text', text: 'result here' }]
  },
})
```

### Return value

`execute` returns a `ContentBlock[]` that becomes the tool result visible to the model:

```ts ignore-check
// Text result
return [{ type: 'text', text: 'file content here...' }]

// Multiple blocks
return [
  { type: 'text', text: 'Found 3 matches:' },
  { type: 'text', text: matchResults.join('\n') },
]
```

### Argument validation

Before calling `execute`, `defineTool` validates model-generated arguments. Invalid input raises `ToolArgsError`; the framework turns it into an `isError` result so the model can correct its call.

Do not repeat type validation inside `execute`.

## Presentation

A tool can define UI presentation methods for terminal and ACP clients:

```ts ignore-check
defineTool({
  name: 'bash',
  // ...
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

## Next steps

- [Plugin configuration](./config.md) — make the tool configurable
- [Capability layering](../practice/) — understand the interface/implementation/consumer pattern
