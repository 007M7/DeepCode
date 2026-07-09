# Registry

插件注册表，管理插件的加载和依赖解析。

## 实例方法

### ctx.plugin(plugin, config?) {#ctx-plugin}

- **plugin:** `Plugin` 插件（函数、对象或类）
- **config:** `object` 传递给插件的配置（可选）
- **返回值:** `Fiber`

加载一个子插件，返回其 Fiber。子 Fiber 的生命周期绑定到父上下文。

```typescript
// 函数插件
ctx.plugin(myPlugin, { key: 'value' })

// 类插件
ctx.plugin(MyService)

// 返回的 Fiber 可以 await 或 dispose
const fiber = ctx.plugin(myPlugin)
await fiber
```

### ctx.inject(names, callback) {#ctx-inject}

- **names:** `string[]` 服务名列表
- **callback:** `(ctx: Context) => void`
- **返回值:** `() => void`

等待指定服务全部就绪后执行 callback。如果服务消失，callback 的效果会自动撤销；服务恢复后重新执行。

```typescript
ctx.inject(['tools', 'llm'], (ctx) => {
  // tools 和 llm 都就绪了
  ctx.tools.register(/* ... */)
})
```

这是 `export const inject = [...]` 声明的底层 API。大多数情况下直接使用声明式写法即可。

## 插件形态

`ctx.plugin()` 接受三种插件形态：

### 函数插件

```typescript
function myPlugin(ctx: Context, config?: Config) {
  // ...
}
myPlugin.name = 'my-plugin'
myPlugin.inject = ['tools']
```

### 对象插件

```typescript
const myPlugin = {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context, config?: Config) {
    // ...
  },
}
```

### 类插件（Service）

```typescript
class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) {
    super(ctx, 'myService')
  }
}
```

## 插件元信息

| 属性 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 插件名称（日志用） |
| `inject` | `string[] \| { required?: string[], optional?: string[] }` | 依赖声明 |
| `Config` | `Schema \| object` | 配置 schema 或默认值 |
