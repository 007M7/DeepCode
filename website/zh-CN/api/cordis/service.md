# Service

Service 基类，用于创建对外暴露能力的插件。

## 基本用法

```typescript
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    myService: MyService
  }
}

export default class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myService')
  }

  // 公开方法
  doSomething() {
    // ...
  }
}
```

加载后，其他插件可通过 `ctx.myService` 访问。

## 构造函数

### new Service(ctx, name)

- **ctx:** `Context` 上下文
- **name:** `string` 服务名（注册到 `ctx[name]`）

## 实例属性

### service.ctx

- **类型:** `Context`

该服务绑定的上下文。

### service\[Service.tracker\]

- **类型:** `object`

服务追踪信息（名称、绑定状态等）。

## 生命周期

Service 子类可以覆写以下方法：

### start()

服务激活时调用。在这里初始化资源。

### stop()

服务停用时调用。在这里释放资源。

## 静态属性

### Service.inject

- **类型:** `string[] | { required?: string[], optional?: string[] }`

声明本服务依赖的其他服务。

## 与 inject 的关系

当一个 Service 被加载：
1. 框架为该服务名创建声明 (`ctx.provide`)
2. 实例赋值到 `ctx[name]`
3. 依赖该服务的所有 Fiber 从 PENDING 转为 LOADING

当 Service 被卸载：
1. `ctx[name]` 被置为 `undefined`
2. 依赖它的 Fiber 被 dispose
3. 当新的 provider 出现时，dependant Fiber 重新加载

## 示例：Harness 中的 Service

```typescript
// dsh-tools 的 ToolRegistry 就是一个 Service
export class ToolRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: ToolDefinition): () => void {
    // ...注册逻辑
    return dispose
  }
}
```
