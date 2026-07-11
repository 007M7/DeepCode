# dsh-scope

Scoped Cordis registrations. `createScope(ctx, key)` returns a context whose registrations are visible only to the matching dispatch subject and are owned by one backing fiber. The agent loop creates one scope per live agent; lower-level packages depend only on the generic `ScopeKey` mechanism.

## Public API

- `createScope(ctx, key): Scope` creates a tagged child context. Derived contexts inherit the tag; a nested scope replaces it. Primitive keys and creation during disposal throw.
- `Scope.ctx` is the registration context.
- `Scope.rawDispose` is the exact Cordis disposer used when nesting the scope in a composite effect.
- `Scope.dispose(): Promise<void>` is the idempotent quiescence boundary for ordinary callers, including races started through `rawDispose`.
- `scopeOf(ctx)` returns the nearest key or `undefined` for global registration.
- `scopeTarget(base, key): Scoped<T>` creates the event receiver that admits global listeners plus listeners for `key`. An undefined key admits only global listeners; Cordis `{ global: true }` remains an explicit bypass.
- `Scoped<T>` brands scope-filtered event receivers at compile time. `isScopeCarrier()` and `carrierKeyOf()` support runtime invariants.
- `scopeHost(ctx, services)` provides a test/tooling host whose disposer awaits its fiber and all scopes it minted.

Visibility and cleanup come from the same registration context, so a contribution cannot be visible to one scope but owned by another. A scoped context retains the minting plugin's injected service view; mint it from a context whose capabilities are appropriate for holders.

See [the agent-scope RFC](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md) for rationale and lifecycle integration.
