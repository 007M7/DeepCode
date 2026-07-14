# dsh-brand

The `Branded<B>` nominal-typing primitive — a tiny, **type-only** package (no runtime code, no harness-package dependency) shared by every package that owns a cross-boundary id.

## What `Branded` is

A brand makes structurally-identical strings non-interchangeable at the type level: an `AgentId` cannot be passed where a `CallId` is expected, even though both are plain `string`s at runtime.

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>

/** Brand a string as a SessionId (a plain cast — zero runtime cost). */
export function SessionId(id: string): SessionId {
  return id as SessionId
}
```

Construction goes through the per-id factory in the OWNING package (a plain cast inside — zero runtime cost). Comparison, logging, JSON serialization, and the wire format all behave exactly as for an ordinary string; the brand is erased at compile time.

## Policy: brand ids that cross package boundaries

A package brands the ids it OWNS — `CallId` in `dsh-llm` (tool-call correlation), `SessionId` in `dsh-session`, `AgentId` in `dsh-agent`, `BashTaskId`/`OwnerToken` in `dsh-bash`. Branding is for ids that cross package boundaries and could plausibly be confused; **not every string needs a brand.**

This package owns ONLY the primitive — no concrete id, no runtime code beyond the (erased) type. Keeping the primitive dependency-free is the point: a capability package can brand its ids without depending on an unrelated package. `dsh-bash`, for example, brands `BashTaskId`/`OwnerToken` by depending on `dsh-brand` alone — it never pulls in `dsh-llm` (or `dsh-session`) just to reach `Branded`.
