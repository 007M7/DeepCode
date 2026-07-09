# Tools (dsh-tools)

Tool 注册表和 `defineTool` DSL。

**包名:** `@deepseek-ai/dsh-tools`
**服务名:** `ctx.tools`

## ToolRegistry

### ctx.tools.register(tool)

- **tool:** `ToolDefinition`
- **返回值:** `() => void` disposer

注册一个 tool。返回的 disposer 可手动撤销注册（通常不需要，插件卸载时自动撤销）。

## defineTool\<S\>(options)

类型安全的 tool 定义辅助函数。

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'

const tool = defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit: { type: 'number', description: 'Max lines to read' },
  },
  async execute(args) {
    // args: { path: string; offset?: number; limit?: number }
  },
})
```

### DefineToolOptions\<S\>

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Tool 名称（全局唯一） |
| `description` | `string` | 发送给模型的描述 |
| `parameters` | `SchemaSpec` | 参数 schema（见下文） |
| `execute` | `(args: InferArgs<S>, exec: ToolExecution) => Promise<ToolExecuteReturn>` | 执行函数 |
| `presentCall?` | `(args: InferArgs<S>) => ToolCallView \| undefined` | UI 展示（纯函数） |
| `presentResult?` | `(args: InferArgs<S>, result: ToolResult) => ToolResultView \| undefined` | 结果 UI 展示（纯函数） |

## SchemaSpec

参数 schema DSL。每个属性是一个 `SchemaProp`：

```typescript
interface SchemaProp {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  required?: true
  description?: string
  enum?: string[]
  properties?: SchemaSpec   // type: 'object' 时
  items?: SchemaProp        // type: 'array' 时
}
```

### 类型推导 (InferArgs)

`InferArgs<S>` 自动从 `SchemaSpec` 推导 TypeScript 类型：

- `required: true` → 必填字段
- 无 `required` → 可选字段（`?`）
- `type: 'object'` + `properties` → 递归推导嵌套对象
- `type: 'array'` + `items` → 推导为数组

## ToolDefinition

运行时 tool 定义（`defineTool` 的返回值）：

```typescript
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  execute(args: unknown, exec: ToolExecution): Promise<ToolExecuteReturn>
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

## ToolExecuteReturn

```typescript
type ToolExecuteReturn =
  | ContentBlock[]                         // 仅内容
  | { content: ContentBlock[]; meta?: unknown }  // 内容 + 元信息
```

## ToolArgsError

当模型生成的参数不匹配 schema 时抛出：

```typescript
class ToolArgsError extends HarnessError {
  code: 'INVALID_ARGS'
  violations: string[]
}
```

框架自动捕获并转换为 `isError` 结果返回给模型。

## validateArgs(spec, args)

- **spec:** `SchemaSpec`
- **args:** `unknown`
- **返回值:** `string[]` 违规信息列表（空 = 合法）

手动校验参数。`defineTool` 内部使用，通常不需要直接调用。

## schemaSpecToJsonSchema(spec)

- **spec:** `SchemaSpec`
- **返回值:** `JsonSchemaObject`

将 SchemaSpec 转换为标准 JSON Schema。用于发送给模型的 wire format。
