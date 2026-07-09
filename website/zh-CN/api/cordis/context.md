# Context

上下文对象是 Cordis 的核心。所有服务、方法、属性都通过 `ctx` 访问。

## 服务与混入

Context 基于组合式 API 设计，大部分属性和方法挂载在服务上。以下是核心 API：

- [`ctx.on`](./events#ctx-on) — 注册事件监听器
- [`ctx.emit`](./events#ctx-emit) — 触发事件
- [`ctx.bail`](./events#ctx-bail) — 短路事件
- [`ctx.serial`](./events#ctx-serial) — 顺序异步事件
- [`ctx.waterfall`](./events#ctx-waterfall) — 管道事件
- [`ctx.effect`](./fiber#fiber-effect) — 注册可逆效果
- [`ctx.plugin`](./registry#ctx-plugin) — 加载子插件
- [`ctx.inject`](./registry#ctx-inject) — 获取依赖的插件
- [`ctx.get`](#ctx-get) — 获取服务
- [`ctx.set`](#ctx-set) — 设置服务
- [`ctx.provide`](#ctx-provide) — 声明服务

## 实例属性

### ctx.fiber

- **类型:** [`Fiber`](./fiber)

当前上下文的作用域对象。

## 实例方法

### ctx.extend(meta)

- **meta:** `object`
- **返回值:** `Context`

构造一个以当前上下文为原型的新上下文实例。

### ctx.intercept(name, config)

- **name:** `string` 服务名称
- **config:** `object` 配置拦截
- **返回值:** `Context`

为指定服务添加一层配置拦截，返回新的上下文实例。

### ctx.isolate(name, label?)

- **name:** `string` 服务名称
- **label:** `symbol` 隔离域符号（可选）
- **返回值:** `Context`

创建一个针对指定服务的隔离域，返回新的上下文实例。隔离域中的同名服务互不影响。

### ctx.get(name)

- **name:** `string` 服务名称
- **返回值:** `Service | undefined`

获取指定名称的服务实例。

### ctx.set(name, value)

- **name:** `string` 服务名称
- **value:** `any` 服务值

设置指定名称的服务。

### ctx.provide(name, value?, options?)

- **name:** `string` 服务名称
- **value:** `any` 初始值（可选）
- **options:** `object`
- **返回值:** `void`

声明一个服务。声明后其他插件可以通过 `inject` 依赖它。

## 静态属性

### Context.events

内置事件服务的 symbol key。

### Context.current

当前活跃的 Context 实例（在异步链中通过 AsyncLocalStorage 追踪）。
