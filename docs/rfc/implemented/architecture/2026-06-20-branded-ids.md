# RFC: Branded IDs everywhere they belong

Status: implemented

## Problem

The harness already brands three identifiers — `CallId` (`packages/llm/llm/src/brand.ts`), `SessionId` (`packages/core/session/src/types.ts`), and `AgentId` (`packages/core/agent/src/types.ts`) — using the `Branded<B> = string & { readonly [BRAND]: B }` machinery (owned by the type-only `@deepseek-ai/dsh-brand` package at `packages/util/brand/` — see its [README](../../../../packages/util/brand/README.md)) and a zero-cost cast factory per type. `dsh-brand` also states the governing policy: *"Branding is for ids that cross package boundaries and could plausibly be confused; not every string needs a brand."* That policy is right; the problem is that it is only half-applied. Two gaps let a structurally-identical-but-semantically-wrong string slip through the type checker today.

**Gap 1 — unbranded IDs in the bash seam.** `BashTask.id` and every executor/tool boundary used bare `string`, even though the generated value has the same `name-N` shape as default session ids. The model also returns this value through `task_id`, so confusing task and session ids was both type-correct and reachable.

The bash **owner token** is the related sub-case: `BashExecRequest.owner?: string` and `BashExecSpec.owner: string | undefined` (`packages/bash/bash/src/types.ts`) are documented as a deliberately *opaque* isolation key, but in every live caller the value IS the owning agent's `session.header.id` (`callerToken = (exec) => exec.agent?.session.header.id` in `packages/bash/tool-bash/src/index.ts`) — i.e. a `SessionId` wearing a `string` disguise. It is compared for access control (`owner !== callerToken(exec)`), so a mismatched-but-well-typed string here is a cross-session isolation bug the type system currently cannot catch. This is the same `session.header.id`-as-owner alias that the [unify-the-agent-id-and-the-session-id](../../proposed/simplification/2026-06-20-unify-agent-and-session-id.md) proposal calls the "bash owner-token alias hole".

**Gap 2 — erosion of existing brands.** `CallId`, `SessionId`, and `AgentId` became bare strings in registry maps, public lookup parameters, ACP session tracking, and the persistence coordinator. Dropping a brand at a lookup boundary defeats its main protection.

## Decision

A type-only change. Brands are zero-cost casts; nothing about runtime behavior, serialization, comparison, or the wire format changes. The work is in three parts, all honoring the existing "not every string" policy.

- **Brand the bash task id.** Add `BashTaskId = Branded<'BashTaskId'>` plus its same-named factory in `packages/bash/bash/src/types.ts` (the package that *owns* the id), importing `Branded` from `@deepseek-ai/dsh-brand` exactly as `SessionId`/`AgentId` already do. The brand primitive lives in the dependency-free `dsh-brand` utility package precisely so `dsh-bash` can brand its ids by depending on it alone — it never pulls in `dsh-llm` (or `dsh-session`) just to reach `Branded`. Thread it through `BashTask.id`, the `BashExecutor` seam methods (`get`/`ownerOf`/`readOutput`/`kill`), the generation site in `dsh-bash-local` (brand the counter output once, at creation), and the `dsh-tool-bash` validate/access surface (`validateTaskId` returns a `BashTaskId`; `task_id` is branded at the tool boundary where the model's string arrives).

- **Mint a distinct `OwnerToken` brand.** Add `OwnerToken = Branded<'OwnerToken'>` in `packages/bash/bash/src/types.ts`; type `BashExecRequest.owner` / `BashExecSpec.owner` / `BashExecutor.ownerOf` as `OwnerToken | undefined`. The `dsh-tool-bash` consumer casts the agent's `session.header.id` (a `SessionId`) into an `OwnerToken` at the boundary — the one place the two vocabularies meet. The bash seam never imports `dsh-session`. (Rationale in the next section.)

- **Stop the brand erosion.** Propagate the existing brands to the `Map` key types and public method params listed under Gap 2 — `Map<SessionId, Session>`, `get(id: SessionId)`, `Map<AgentId, Agent>`, `Map<CallId, …>`, the ACP `SessionRecord.sessionId: SessionId` surface, the coordinator's `Map<SessionId, …>`. This is the larger mechanical share of the diff and the part that makes the *existing* brands actually load-bearing on lookups, not just on the struct fields.

Illustrative shape (the factory pattern is identical to the three existing brands):

```ts ignore-check
import type { Branded } from '@deepseek-ai/dsh-brand'

/** A background bash task handle (generated `bash-N` by the local executor). */
export type BashTaskId = Branded<'BashTaskId'>
export function BashTaskId(id: string): BashTaskId {
  return id as BashTaskId
}

/** A bash task's opaque isolation key — the consumer's owner identity, NOT the bash seam's. */
export type OwnerToken = Branded<'OwnerToken'>
export function OwnerToken(id: string): OwnerToken {
  return id as OwnerToken
}
```

## Alternatives considered

### Why not typing `owner` as `SessionId`?

The executor treats ownership as opaque and must not depend on the session model. A distinct `OwnerToken` preserves that boundary while preventing raw strings or task ids from being passed as owners. `dsh-tool-bash`, which owns the access policy, performs the single conversion from `SessionId`.

## Out of scope / possible extensions

Kept deliberately narrow per the "not every string needs a brand" policy. Each of these is a plausible future brand, deferred with a reason, not a commitment:

- **`ModelId`** (`GenerateOptions.model`, the `LlmService` adapter-registry key) — a real cross-package lookup key (config → agent → llm → adapter); a reasonable next brand, left out only to keep this RFC's blast radius focused.
- **`ToolName`** (the `ToolRegistry` key) — author-defined, human-readable, and rarely confused with another id; the weakest candidate, likely not worth a brand.
- **`ErrorCode`** (`HarnessError.code`) — a closed vocabulary (`ABORTED`, `NO_ADAPTER`, …), not a per-instance id; better served by a string-literal union than a brand, if anything.
- **Numeric ordinals** — turn number, step number, and the event `seq` are `number`, not `string`, so `Branded<string>` does not apply; a parallel `number & { readonly [BRAND]: B }` variant could brand them, but they are positional ordinals rarely passed across boundaries, so the payoff is low.
- **Validated construction** — the brand factories are pure casts with no runtime check, and every boundary (ACP `sessionId`, provider-issued `call.id`, the empty-string fallback in `dsh-llm-deepseek`) trusts the raw string today. A `SessionId.parse()` / `isValid()` companion that throws on malformed input at boundaries is a genuine gap, but it is a *runtime-behavior* change with its own design (what is "malformed"? what do we do on failure?) and belongs in its own RFC, not bundled into this type-only pass.

## Verification

`BashTaskId` and `OwnerToken` are defined in `dsh-bash` and threaded through the executor, local implementation, and model-facing tool without adding a `dsh-session` dependency. Collections, public parameters, and exported signatures use the applicable brand for `CallId`, `SessionId`, `AgentId`, or `BashTaskId` rather than bare `string`; raw provider, ACP, and model inputs enter through the brand factory instead of scattered casts.

## Consequences

- **Mechanical churn across two surfaces.** Propagating brands touches the bash seam (interface + impl + consumer) and the ACP session-id surface plus the persistence coordinator. The churn is broad but low-severity: a missed site is a compile error, not a silent bug. The change is observably type-only — no snapshot or e2e behavioral diff. It sits next to the [unify-the-agent-id-and-the-session-id](../../proposed/simplification/2026-06-20-unify-agent-and-session-id.md) proposal (both touch the session-id / owner-token boundary); if that proposal lands, `OwnerToken` still stays distinct from the unified id for the decoupling reason above.
- **Brands do not validate.** A brand is a confusability guard, not a correctness proof: a *wrong* session id that is still a well-formed string passes the type checker exactly as before. This RFC does not close that gap (see Out of scope) — it only stops the *category* error of passing the wrong *kind* of id.
- **The "where to stop" line stays a judgment call.** Branding `BashTaskId` but not `ToolName`, `OwnerToken` but not `ModelId`, is a taste call about which strings "could plausibly be confused." Reasonable reviewers may want more or fewer; the policy in `brand.ts` is the tie-breaker, and this RFC errs toward the ids that are model-facing or used for access control.
