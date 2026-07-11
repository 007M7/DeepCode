# dsh-scope

Scoped-context registration primitive. `createScope(ctx, key)` mints a Cordis context that TAGS everything registered through it with an opaque `ScopeKey` and OWNS those registrations' lifetime (one backing fiber drives both facts); `scopeOf(ctx)` reads the tag; `scopeTarget(base, key)` builds the dispatch carrier that makes an event scope-filtered — listeners registered through a scoped context fire only for their key's subject, while plain plugin listeners keep firing for every subject. The agent loop is the one scope minter today (one scope per live agent, key = the `Agent` object — the `Agent.ctx` contract in `dsh-agent`), but the mechanism is key-agnostic so packages below the agent layer (`dsh-session`, `dsh-system-prompt`) depend on it without a dependency cycle.

## Public API

- `createScope(ctx: Context, key: ScopeKey): Scope` Mint a scope under `ctx`'s fiber. Usable synchronously (effect collection is uid-gated; service resolution falls through to the minting plugin's dependency surface). Throws on a primitive key, or when `ctx`'s fiber is disposing (`INACTIVE_EFFECT`).
- `Scope.ctx` The tagged context: registrations through it are scope-visible AND scope-lifetime. Derived contexts (an `extend`, a fiber mounted under it) inherit the tag; nested scopes shadow (nearest tag wins).
- `Scope.rawDispose` The EXACT Cordis disposer for the backing fiber — a composite (generator) effect yields THIS function to nest the scope's teardown at that yield position (Cordis dedupes nested effects by function identity; yielding a wrapper leaves the scope disposing as a concurrent sibling).
- `Scope.dispose(): Promise<void>` Idempotent, shared quiescence boundary for every registration made through the scope. Racing/repeat calls await the same teardown, including when `rawDispose` invoked the underlying single-shot Cordis disposer first.
- `scopeOf(ctx: Context): ScopeKey | undefined` The tag a context (or any context derived from it) carries; `undefined` = context-global.
- `scopeTarget(base: T, key?: ScopeKey): Scoped<T>` Build the dispatch `thisArg` for a scope-filtered event: composes `base`'s own `Context.filter` with the scope predicate (untagged listener ⇒ admitted; tagged ⇒ admitted iff tag === key; `key === undefined` ⇒ untagged only). Listener `this` stays `base`-shaped. `{ global: true }` listeners bypass filtering (Cordis semantics).
- `Scoped<T>` The compile-time carrier brand: scope-filtered events demand it as their `this` type, so dispatching with a bare subject is a compile error.
- `isScopeCarrier(value)` / `carrierKeyOf(value)` Runtime carrier marks, used by the dev invariants to assert every scope-filtered dispatch carries a carrier keyed to the subject its arguments name.
- `scopeHost(ctx, services)` Test/tooling host that snapshots the requested service list before activation, fails loud with stable missing-service diagnostics, and whose shared `dispose()` waits for both the host fiber and every minted scope, including a child already tearing down through `rawDispose`.

## Design contract

Ownership and visibility derive from ONE fact — which context a registration went through. An explicit `{ scope }` registration parameter could express "visible to X, disposed with Y", which is almost always a bug; the scoped context makes it unrepresentable. Rationale and alternatives: [the agent-scope RFC](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md).

Handing out a scoped context hands out the minting plugin's service-resolution capability (resolution walks the minting fiber's dependency chain, not the holder's) — mint scopes from a plugin whose `inject` surface is what scope holders should reach.
