# 作用域注册

[English](scope.md) | 中文

[scope 包（package）](../../packages/core/scope)提供身份标识与载体词汇，使一个注册上下文同时表达逐 agent（智能体）的可见性与共享的生命周期归属。它是一个库级原语，而非 Cordis 服务；[agent-scope 运行时设计 RFC](../rfc/implemented/architecture/2026-07-12-agent-scope-runtime-design.md#scope-routing-one-opaque-key-selects-one-layer) 阐述了实现原理，包的 [README](../../packages/core/scope/README.md) 说明了可调用 API 与过滤语义。

源码：[`packages/core/scope/src/index.ts`](../../packages/core/scope/src/index.ts)。

## 身份标识与分发载体

`ScopeKey` 是一个不透明的对象身份标识。已交付的 agent loop（智能体循环）使用活跃的 `Agent` 对象作为自身的 key，但该原语从不检视该对象。

```ts type-equiv
type ScopeKey = object
```

`Scoped<T>` 是编译期品牌标记，标注在 `scopeTarget(base, key)` 返回的不透明路由接收器上。作用域过滤的事件声明要求以此载体作为 `this` 类型，而真正的事件主体仍作为显式参数传入。

```ts type-equiv
type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }
```

## 拥有所有权的注册上下文

`Scope` 将带标签的注册上下文与两个拆卸接口配对。`rawDispose` 保留有序复合 effect 所需的精确 Cordis disposer 身份；`dispose()` 是面向直接调用方和竞态调用方的公共停稳边界。

```ts type-equiv
interface Scope {
  ctx: Context
  rawDispose: () => Promise<void> | void
  dispose(): Promise<void>
}
```
