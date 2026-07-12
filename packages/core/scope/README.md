# dsh-scope

Scoped-context registration primitive. `createScope(ctx, key)` mints a Cordis context that TAGS everything registered through it with an opaque `ScopeKey` and OWNS those registrations' lifetime (one backing fiber drives both facts); `scopeOf(ctx)` reads the tag; `scopeTarget(base, key)` builds the dispatch carrier that makes an event scope-filtered — listeners registered through a scoped context fire only for their key's subject, while plain plugin listeners keep firing for every subject. The agent loop is the one scope minter today (one scope per live agent, key = the `Agent` object — the `Agent.ctx` contract in `dsh-agent`), but the mechanism is key-agnostic so packages below the agent layer (`dsh-session`, `dsh-system-prompt`) depend on it without a dependency cycle.

## Public API

- `createScope(ctx: Context, key: ScopeKey): Scope` Mint a scope under `ctx`'s fiber. Usable synchronously (effect collection is uid-gated; service resolution falls through to the minting plugin's dependency surface). The typed, same-process key is trusted; an inactive minting context still fails through Cordis (`INACTIVE_EFFECT`).
- `Scope.ctx` The tagged context: registrations through it are scope-visible AND scope-lifetime. Derived contexts (an `extend`, a fiber mounted under it) inherit the tag; nested scopes shadow (nearest tag wins).
- `Scope.rawDispose` The EXACT Cordis disposer for the backing fiber — a composite (generator) effect yields THIS function to nest the scope's teardown at that yield position (Cordis dedupes nested effects by function identity; yielding a wrapper leaves the scope disposing as a concurrent sibling).
- `Scope.dispose(): Promise<void>` Idempotent, shared quiescence boundary for every registration made through the scope. Racing/repeat calls await the same teardown, including when `rawDispose` invoked the underlying single-shot Cordis disposer first.
- `scopeOf(ctx: Context): ScopeKey | undefined` The tag a context (or any context derived from it) carries; `undefined` = context-global.
- `scopeTarget(base: T, key: ScopeKey | undefined): Scoped<T>` Build the opaque dispatch `thisArg` for a scope-filtered event. It composes `base`'s existing `Context.filter` with the scope predicate (untagged listener ⇒ admitted; tagged ⇒ admitted iff tag === key; `key === undefined` ⇒ untagged only). The carrier contains routing state only; the real subject is carried by the event arguments. `{ global: true }` listeners bypass filtering (Cordis semantics).
- `Scoped<T>` The compile-time opaque carrier brand: scope-filtered events demand it as their `this` type, so dispatching with a bare subject is a compile error. The type parameter records the subject type but does not expose its properties.
- `isScopeCarrier(value)` / `carrierKeyOf(value)` Runtime carrier marks, used by the dev invariants to assert every scope-filtered dispatch carries a carrier keyed to the subject its arguments name.

## Design contract

Ownership and visibility derive from ONE fact — which context a registration went through. An explicit `{ scope }` registration parameter could express "visible to X, disposed with Y", which is almost always a bug; the scoped context makes it unrepresentable. This is trusted registration and listener routing, not sandboxing or an authority hierarchy: a same-process plugin is not confined, and a child scope need not be a subset of its parent's view. Rationale, alternatives, and the security non-goal: [the agent-scope RFC](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-explicit-non-goals).

Handing out a scoped context hands out the minting plugin's service-resolution surface (resolution walks the minting fiber's dependency chain, not the holder's) — mint it from the plugin whose dependencies the scoped registrations need to resolve.

## Known Limitations and Deferred Work

- **Only scope-aware surfaces isolate state** — registries must file by `scopeOf()` and events must dispatch through `scopeTarget()`; an arbitrary Cordis service remains context-global merely because it is called through a scoped context.
- **A context carries one nearest scope key** — nested scopes shadow their parent's tag rather than forming hierarchical or multi-membership policy sets.
- **Service reachability comes from the scope minter** — handing out `Scope.ctx` also hands out the minting plugin's injected service surface, so a broader minter cannot later be narrowed by the holder.
