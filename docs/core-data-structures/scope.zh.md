# 作用域注册

[English](scope.md) | 中文

[scope 包（package）](../../packages/core/scope)提供 identity、carrier 与 scoped-layer 词汇，使同一个注册上下文同时代表逐 agent（智能体）可见性和共享生命周期所有权。它是库原语，而不是 Cordis 服务；生命周期设计理由由 [agent-scope 运行时设计 Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.md#scope-routing-one-opaque-key-selects-one-layer)规定，注册表层决策由[共享存储 Agent Note](../../.agents/notes/implemented/architecture/2026-07-12-scoped-layers-store.md)规定，可调用 API 与过滤语义则由包 [README](../../packages/core/scope/README.md)规定。

源码：[`packages/core/scope/src/index.ts`](../../packages/core/scope/src/index.ts) 与 [`packages/core/scope/src/store.ts`](../../packages/core/scope/src/store.ts)。

## 身份标识与分发载体

`ScopeKey` 是一个不透明的对象身份标识。已交付的 agent loop（智能体循环）使用活跃的 `Agent` 对象作为自身的 key，但该原语从不检视该对象。

```ts type-equiv
/** An opaque, identity-compared scope key. */
type ScopeKey = object
```

`Scoped<T>` 是编译期品牌标记，标注在 `scopeTarget(base, key)` 返回的不透明路由接收器上。作用域过滤的事件声明要求以此载体作为 `this` 类型，而真正的事件主体仍作为显式参数传入。

```ts type-equiv
/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }
```

## 拥有所有权的注册上下文

`Scope` 将带标签的注册上下文与两个拆卸接口配对。`rawDispose` 保留有序复合 effect 所需的精确 Cordis disposer 身份；`dispose()` 是面向直接调用方和竞态调用方的公共停稳边界。

```ts type-equiv
/** A minted registration scope and its quiescent disposal boundaries. */
interface Scope {
  /** Context through which scope-owned registrations are made. */
  ctx: Context
  /** Exact Cordis disposer, used when nesting this scope in an ordered composite effect. */
  rawDispose: () => Promise<void> | void
  /** Dispose every scope-owned registration; racing calls await the same completion. */
  dispose(): Promise<void>
}
```

## 带作用域的注册表层

`ScopeLayer` 表示一个注册表在全局或确切作用域层级的完整贡献。具体 layer 可以聚合多个具名与匿名 table；整个 layer 为空时，`ScopedLayers` 可以回收带作用域状态，而不会丢弃兄弟 table。

```ts type-equiv
/** One scope's aggregate contribution to a registry. */
interface ScopeLayer {
  /** Whether every table in this layer is empty. */
  isEmpty(): boolean
}
```

`ScopedLayers<L>` 拥有立即创建的全局 layer，以及惰性创建的确切作用域 layer。读取不会创建 layer：`peek(undefined)` 表示没有 overlay，而 `merge()` 会物化按插入顺序排列的全局具名 entry，随后是带作用域的 shadow。注册使用同一个上下文表示可见性与 Cordis effect 所有权，在可选通知前收集一个同步 undo，返回 Cordis 的确切 disposer，并且只在带作用域 layer 的完整 `ScopeLayer` 为空时回收它。

`NamedEntries<V>` 提供按插入顺序的查找与 live iteration，重复错误由调用方所有。`AnonymousEntries<V>` 为每次 append 分配唯一标识，使相等的值仍相互独立。迭代在同一非空 table generation 内保持 live；排空 table 会让现有 iterator 与后续插入脱离。两者都返回幂等的确切 entry undo；共享的 `EntryValues` 实现接口不公开。
