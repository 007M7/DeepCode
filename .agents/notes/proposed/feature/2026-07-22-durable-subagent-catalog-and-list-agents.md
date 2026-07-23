# Agent Note: Durable subagent catalog and list_agents

Status: proposed

English | [中文](2026-07-22-durable-subagent-catalog-and-list-agents.zh.md)

## Problem

Continuable background subagents expose a stable child id and persist the reconstruction descriptor in that child's session, so `send_message` can resume a known child without any listing operation. `list_agents` has a different requirement: after parent restart, enumerate only that parent's direct continuable children even when the caller no longer knows their ids. The durable child-handle and activation design is owned by [continuable background subagents](2026-07-21-continuable-background-subagents.md); this note owns enumeration and its model-facing query.

Enumeration must cross-check immutable session lineage, descriptor validity, and process-local activation state without loading or resuming an Agent merely to display it. It must also define how missing, corrupt, deleted, or unsupported children affect the list and whether repeatedly loading many child logs needs an index.

## Proposal

Treat parent-to-child enumeration and `list_agents` as one separately reviewed feature built on the durable child-handle contract. `SubagentControlService.listChildren(parent)` must:

- find materialized session headers whose `parentSession` identifies the caller's session;
- load and validate each candidate's `subagent/descriptor` event without activating the child;
- union those durable candidates with the parent's process-local Task associations, including active children that have not materialized yet;
- omit one-shot children without a diagnostic, and omit a candidate that becomes unavailable or has a corrupt or unsupported descriptor with a per-child diagnostic;
- expose an inactive child as resumable only when its descriptor is valid and its provider is currently registered with `resume?()`;
- return every resulting child in stable `createdAt` ascending, child-id ascending order.

Descriptor format, persistence, by-id lookup, direct-parent authorization, and cold resume remain owned by the activation proposal. Listing consumes those facts but cannot weaken them or invent a second descriptor representation.

### Enumeration decision

The first implementation uses `SessionPersistence.list()` to obtain materialized headers, filters on `SessionHeader.parentSession`, and unions those ids with Task associations owned by the parent. An associated child is resolved from the live association and is never passed to `SessionPersistence.load()`; only inactive direct-child candidates are loaded to fold their descriptors. The activation contract calls a preallocated id without a durable header and descriptor an **unmaterialized child**: by-id control reports an inactive instance as unavailable, but an active association still appears in `list_agents` as `running`. Once that Task becomes terminal, the child remains discoverable only if its durable descriptor validates. A materialized one-shot child lacks the descriptor and is excluded. This path requires no parent-session catalog event or new persistence backend.

This O(number of direct children) load path is the correctness baseline. If measured scale later requires an index, that index is derived state: session headers and child descriptors remain authoritative, and rebuilding or corruption fallback must reproduce the same results. An index cannot become a second authorization source or make an unmaterialized child visible.

`SessionPersistence.load()` may durably repair an interrupted child log by appending synthetic closing events. The first version accepts this existing persistence side effect: `listChildren()` creates no Agent and appends no catalog or descriptor event itself, but it is not a storage-read-only operation. It reads the model-hidden descriptor retained in the child log by the activation contract, so compacted and uncompacted children must enumerate identically.

### `list_agents` contract

`SubagentControlService.listChildren(parent)` returns all direct continuable children in the union of durable candidates and active Task associations, plus non-fatal diagnostics for inactive candidates it could not load, validate, or resume. An association records its creation time when the control service allocates the child id; a materialized child uses `SessionHeader.createdAt`. Children are sorted by that `createdAt` ascending, then child id ascending. Diagnostics follow their candidate's same key. The model-facing `list_agents` tool takes no arguments and is a thin adapter in `@deepseek-ai/dsh-tool-subagent-control`; it renders the complete sorted children and diagnostics together, and reports two operational child states:

- `running`: a non-terminal Task-backed activation exists, including startup before materialization and settlement before Task terminal publication;
- `resumable`: no activation is associated, a valid durable descriptor exists, and the named provider is currently registered with `resume?()`.

These values are not `AgentStatus`. A plain Agent registry entry without a Task association is an ownership conflict, not a third list state. Inactive candidates use three diagnostic reasons: `corrupt` for malformed committed data or descriptor content, `unsupported` for an unknown descriptor version, and `unavailable` when the candidate disappears, another child-specific load fails, or its provider is absent or lacks `resume?()`. Each diagnostic identifies the child id and reason without exposing model-hidden descriptor content; the candidate is omitted while healthy siblings remain visible. Failure of the initial `SessionPersistence.list()` operation fails the whole call because no candidate set exists. Headers whose `parentSession` names another parent are filtered before descriptor loading and produce no diagnostic.

The first version has no child deletion operation. If later product behavior deletes child sessions, persistence listing naturally drops a deleted child; any future derived index must remove or tombstone the same entry so `list_agents` cannot retain stale state.

## Alternatives considered

**Fold listing into the activation RFC.** Descriptor-by-id persistence and cold resume do not require parent-to-child enumeration. Keeping the query separate lets `send_message` land without taking on listing states, scanning performance, or deletion behavior.

**List every persisted session whose header names the parent.** `parentSession` proves lineage but does not prove that the child is continuable. Listing must also load and validate the descriptor.

**Use the live Agent registry as the catalog.** Runs are deliberately disposed after every Task, and registry state disappears on restart. It cannot support durable discovery.

**Persist a parent-session catalog event.** Direct-child headers already provide the durable enumeration seed, and the child descriptor is the reconstruction authority. A second parent log duplicates state and creates cross-session ordering and stale-entry behavior without helping by-id resume.

**Fail the whole listing when one child cannot be loaded.** This makes corruption impossible to overlook, but one damaged sibling removes visibility into every healthy child. Per-child diagnostics preserve discovery while keeping each omission explicit.

**Add a repair-free descriptor inspection API.** This would make discovery strictly storage-read-only, but expands the persistence seam solely to avoid the interrupted-tail repair that normal session load and eventual resume already require. The first version accepts `load()` semantics and documents the side effect.

**Paginate or cap the model-facing result.** This bounds one tool result, but makes discovery stateful and can hide older children unless the model follows a cursor. The first version has no arguments and returns the complete stably ordered set; deployments with many durable children accept the corresponding context cost.

## Acceptance criteria

- Durable enumeration uses materialized session headers as candidates, validates `parentSession`, and includes only inactive children whose persisted descriptor satisfies the durable child-handle contract; the final result unions those children with parent-owned active associations.
- Listing loads no Agent and appends no catalog or descriptor event itself, but may trigger `SessionPersistence.load()` interrupted-tail repair for inactive children; an already-associated child is never loaded, and compacted and uncompacted logs return the same children.
- `list_agents` takes no arguments and returns all valid direct continuable children plus per-child diagnostics, sorted by `createdAt` ascending and child id ascending.
- Active Task associations appear as `running` even before durable materialization; after Task terminal, the child appears as `resumable` only when its descriptor validates and its currently registered provider implements `resume?()`.
- `list_agents` reports no pass-through runtime status, uses only `corrupt`, `unsupported`, or `unavailable` diagnostic reasons, and never exposes descriptor contents in a diagnostic.
- Parent resume does not activate children; listing reads durable state and overlays only already-associated process-local Tasks.
- A preallocated-but-unmaterialized child id, one-shot child, corrupt descriptor, unsupported descriptor version, and stale derived-index entry are never advertised as resumable; non-child headers are filtered before load.
- A corrupt, unsupported, disappeared, or unloadable candidate cannot hide healthy siblings: it is omitted with an id-and-reason diagnostic, while failure of the initial persistence listing fails the whole call.
- Keyless tests cover fresh and compacted discovery, active unmaterialized children, transition from running association to durable resume, provider absence, stable ordering, restart, parent-header prefiltering, isolated child diagnostics, load repair, scan behavior, and stale-index fallback. The model-facing complete-list-plus-diagnostics result has runnable snapshot coverage.

## Risks

- Listing performs one header scan and may load every direct-child log; a later derived index must preserve the same authorization, per-child diagnostic, and fallback behavior.
- Listing may repair interrupted child logs and persist synthetic closing events even though it creates no Agent. This is the existing `SessionPersistence.load()` contract, not a hidden catalog write.
- The first version has no deletion operation, so persisted children remain listed for as long as their sessions remain in persistence even though live Agent resources remain bounded by active Tasks.
- The no-argument tool returns every direct continuable child and diagnostic. Stable ordering makes the result deterministic but does not bound model-context growth; pagination or deletion remains a later product decision.
- Task associations exist only in one runtime. Another process can report a durable child as `resumable` while work for that child is active elsewhere unless the deployment adds a shared lease.
