# dsh-invariants

Configurable registry service for package-owned runtime invariant checks. The root plugin registers `ctx.invariants`; it contains no product checks or product-package imports. Every workspace package publishes a `./invariant` companion that registers its exact npm package name.

## Service: `InvariantService` (`ctx.invariants`)

```ts
interface Config {
  enabled?: boolean
  package_allowlist?: string[]
  package_blocklist?: string[]
}
```

Defaults are `enabled: true`, `package_allowlist: []`, and `package_blocklist: []`. A package is selected only when the service is enabled, the empty allowlist or at least one allowlist pattern matches its full npm name, and no blocklist pattern matches. Blocklist matches therefore override allowlist matches.

Each entry is a case-sensitive JavaScript regular-expression source compiled with `new RegExp(pattern)`. Matching is unanchored unless the source supplies `^` and `$`; `/pattern/flags` syntax is not parsed. Blank, whitespace-padded, invalid, or duplicate entries within one list fail service startup. A valid pattern may match no currently loaded package so later loading and HMR remain deterministic.

`ctx.invariants.register(packageName, installer)` reserves one active registration for the full npm package name, including when filters keep its installer inactive, and returns its disposer. An enabled contribution runs in a dedicated child Cordis fiber. The installer can declare its required service surface through `installer.inject` and receives `fail(message)`, which throws an `InvariantError` bound to the registering package. Synchronous or asynchronous installer completion is joined before registration succeeds; failure disposes the child and releases ownership atomically.

The service owns every registration fiber, while the returned disposer also belongs to the companion fiber. Unloading either side removes the listeners and reservation completely. A companion can therefore reload and register the same package name without retaining trace state or duplicate listeners; packages that need an existing baseline rebuild it during installation.

`InvariantError` extends `Error`, carries stable `code: 'INVARIANT'`, and exposes the owning `packageName` without adding a product-package dependency to the service.

## Package companions

Every companion installs at least one executable, package-specific contract and reports failure through its bound reporter. There is no generated or ownership-only baseline. `pnpm run verify-package-invariants` rejects generated markers, empty installers, installers that ignore the reporter, duplicate name-based plugin observers, incorrect registration names, and incomplete export, publication, dependency, TypeScript-reference, or bundle wiring.

Packages select the narrowest runtime form that protects their public contract:

| Package shape | Companion check |
|---|---|
| Cordis plugin | `observePluginInvariant` validates the plugin's own declared name, required injections, owned effect group, provided services, and optional package-specific relation for existing, late, and HMR-activated fibers. |
| Cordis service seam | `observeServiceInvariant` plus `serviceShapeViolation` validates current and future structural implementations, including conforming third-party backends and test doubles. |
| Pure library, bin, or support package | `assertInvariant` checks stable protocol algebra, parser mapping, path/timeout/retention rules, normalization, or entrypoint shape during child startup. |

Four companions additionally install stateful event and request checks:

| Companion | Registration | Checks |
|---|---|---|
| `@deepseek-ai/dsh-session/invariant` | `@deepseek-ai/dsh-session` | sequence, turn/step enclosure, and same-step tool call/result trace |
| `@deepseek-ai/dsh-agent/invariant` | `@deepseek-ai/dsh-agent` | agent-status transitions |
| `@deepseek-ai/dsh-scope/invariant` | `@deepseek-ai/dsh-scope` | scoped-event carrier presence and subject consistency |
| `@deepseek-ai/dsh-agent-loop/invariant` | `@deepseek-ai/dsh-agent-loop` | loop-built model-request reconstruction from the session log |

The root entrypoint of each owner remains independent of diagnostics. Loading the service alone installs no checks; loading a companion without the service remains pending on its declared `invariants` dependency. Name-based plugin observers match only a fiber's own declared runtime name, not anonymous child fibers that inherit a parent display name. They avoid importing the product entrypoint before it is loaded; pure-library checks likewise defer owner imports into the installer child so Vitest mocks and deployment loaders establish their module boundary first.

## Composition

```ts
import type { Context } from 'cordis'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'

declare const ctx: Context

ctx.plugin(InvariantService, {
  enabled: true,
  package_allowlist: ['^@deepseek-ai/dsh-'],
  package_blocklist: ['^@deepseek-ai/dsh-agent-loop$'],
})
ctx.plugin(SessionInvariant)
```

The standard agent spine mounts the service and the four stateful companions. Custom compositions explicitly add the companions for the packages whose contracts they want checked and may disable or filter them without changing package entrypoints. Plugin and service helpers multiplex package contracts through indexed lifecycle listeners shared by the Cordis root, while contribution disposal removes only that owner's contract. Vitest gives every ordinary root an explicitly enabled service and mounts the current test package's companion; one exhaustive topology test mounts all companions once, and focused invariant-service tests construct their own topology to exercise filtering and lifecycle behavior.

## Model Experience

None, as the service and companions observe runtime events and requests but never alter prompts, messages, schemas, streams, or tool results.

#### KV Cache effect

None; invariant checks do not assemble or send provider requests.

## Known Limitations and Deferred Work

- A name-based plugin observer assumes Cordis plugin names are unique within one root; a package can provide the exact callback when importing it does not preload an unrelated runtime.
- Pure-library contracts are sampled when their companion child activates rather than observed continuously; mutable package behavior belongs on an event, service, or plugin-fiber observer.
- Request reconstruction covers frozen loop-built requests with a live session id; direct one-shot calls remain outside that companion's marker contract.
- Regular-expression filters are fixed for the service lifetime; changing them requires ordinary Cordis plugin reload.
