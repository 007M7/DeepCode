# dsh-invariants

Configurable registry service for package-owned runtime invariant checks. The root plugin registers `ctx.invariants`; it contains no product checks or product-package imports. Packages publish optional `./invariant` companion plugins that contribute their own assertions.

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

`ctx.invariants.register(packageName, installer)` reserves one active registration for the full npm package name, including when filters keep its installer inactive, and returns its disposer. An enabled contribution runs in a dedicated child Cordis fiber. The installer can declare its required service surface through `installer.inject` and receives `fail(message)`, which throws an `InvariantError` bound to the registering package. Installer failure disposes the child and releases ownership atomically.

The service owns every registration fiber, while the returned disposer also belongs to the companion fiber. Unloading either side removes the listeners and reservation completely. A companion can therefore reload and register the same package name without retaining trace state or duplicate listeners; packages that need an existing baseline rebuild it during installation.

`InvariantError` extends `Error`, carries stable `code: 'INVARIANT'`, and exposes the owning `packageName` without adding a product-package dependency to the service.

Session itself owns immutable, surface-valid log storage in every composition: it takes one lossless JSON snapshot of each candidate, validates complete provenance and positional replacement, restricts `tool/result` replacement to one current result's `content`, deep-freezes the accepted record, and exposes the log through immutable array snapshots. The `dsh-session` invariant companion checks the remaining cross-record rules that Session does not own.

## Package companions

| Companion | Registration | Checks |
|---|---|---|
| `@deepseek-ai/dsh-session/invariant` | `@deepseek-ai/dsh-session` | sequence, turn/step enclosure, fresh tool execution, and turn-enclosed result rewrites |
| `@deepseek-ai/dsh-agent/invariant` | `@deepseek-ai/dsh-agent` | agent-status transitions |
| `@deepseek-ai/dsh-scope/invariant` | `@deepseek-ai/dsh-scope` | scoped-event carrier presence and subject consistency |
| `@deepseek-ai/dsh-agent-loop/invariant` | `@deepseek-ai/dsh-agent-loop` | loop-built model-request reconstruction from the session log |

The root entrypoint of each owner remains independent of diagnostics. Loading the service alone installs no checks; loading a companion without the service remains pending on its declared `invariants` dependency.

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

The standard agent spine mounts the service and all four companions. Custom compositions choose the companions they want and may disable or filter them without changing package entrypoints.

## Model Experience

None, as the service and companions observe runtime events and requests but never alter prompts, messages, schemas, streams, or tool results.

#### KV Cache effect

None; invariant checks do not assemble or send provider requests.

## Known Limitations and Deferred Work

- The shipped checks cover only the four listed package contracts; a merge-extended event family has no family-specific assertion until its owner publishes one.
- Request reconstruction covers frozen loop-built requests with a live session id; direct one-shot calls remain outside that companion's marker contract.
- Regular-expression filters are fixed for the service lifetime; changing them requires ordinary Cordis plugin reload.
