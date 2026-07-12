# Scoped Registration

The [scope package](../../packages/core/scope) supplies the identity and carrier vocabulary that makes one registration context mean both per-agent visibility and shared lifetime ownership. It is a library primitive rather than a Cordis service; the [agent-scope runtime-design RFC](../rfc/implemented/architecture/2026-07-12-agent-scope-runtime-design.md#scope-routing-one-opaque-key-selects-one-layer) owns the implementation rationale, while the package [README](../../packages/core/scope/README.md) owns the callable API and filtering semantics.

Source: [`packages/core/scope/src/index.ts`](../../packages/core/scope/src/index.ts).

## Identity and dispatch carrier

`ScopeKey` is an opaque object identity. The shipped loop uses the live `Agent` object as its own key, but the primitive never inspects the object.

```ts type-equiv
type ScopeKey = object
```

`Scoped<T>` is the compile-time brand on the opaque routing receiver returned by `scopeTarget(base, key)`. Scope-filtered event declarations require this carrier as their `this` type, while the real event subject remains an explicit argument.

```ts type-equiv
type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }
```

## Owned registration context

`Scope` pairs the tagged registration context with two teardown surfaces. `rawDispose` preserves the exact Cordis disposer identity needed by an ordered composite effect; `dispose()` is the public shared quiescence boundary for direct and racing callers.

```ts type-equiv
interface Scope {
  ctx: Context
  rawDispose: () => Promise<void> | void
  dispose(): Promise<void>
}
```
