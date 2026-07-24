# Agent Note: Durable subagent catalog and list_agents

Status: proposed

English | [中文](2026-07-22-durable-subagent-catalog-and-list-agents.zh.md)

## Problem

Continuable background subagents expose a stable child id and persist the reconstruction descriptor in that child's session, so `send_message` can resume a known child without any listing operation. `list_agents` has a different requirement: after parent restart, enumerate only that parent's direct continuable children even when the caller no longer knows their ids. The durable Session and Activation design is owned by [continuable subagents](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md); this note owns enumeration and its model-facing query.

Enumeration must cross-check immutable session lineage, descriptor validity, and the live-preferred session corpus without loading or resuming an Agent merely to display it. It must also define how missing, corrupt, deleted, or unsupported children affect the list and whether repeatedly loading many child logs needs an index.

## Proposal

Treat parent-to-child enumeration and `list_agents` as one separately reviewed feature built on the durable child-session contract. `SubagentService.listChildren(parent)` must:

- use `ctx.sessionQuery.traceSession(parent.session.id)` to obtain the caller's direct live-preferred child sessions;
- read and validate each candidate's `subagent/descriptor` event without activating the child;
- omit one-shot children without a diagnostic, and omit a candidate that becomes unavailable or has a corrupt or unsupported descriptor with a per-child diagnostic;
- expose only children whose descriptor carries a durable creation `label`;
- report a live child as `running` and a persisted-only child as `complete`;
- return every resulting child in stable `createdAt` ascending, child-id ascending order.

Descriptor persistence, by-id lookup, direct-parent authorization, and provider-independent cold resume remain owned by the implemented Activation contract. This proposal extends the descriptor with a durable `label` and requires listing to diagnose duplicate descriptor events; it cannot weaken the existing facts or invent a second descriptor representation.

### Enumeration decision

The first implementation consumes `ctx.sessionQuery.traceSession(parent.session.id)` and considers only the trace's first-level descendants. Session query already merges `ctx.sessions` with `ctx.sessionPersistence` using live precedence, preserves immutable-header consistency, derives direct-child lineage from `SessionHeader.parentSession`, and sorts siblings by `createdAt` ascending and child id ascending. `listChildren()` does not reproduce that corpus logic or inspect the continuation manager's process-local Activation map.

Corpus construction precedes per-child descriptor inspection. A failure while building the initial trace, including persistence listing failure, a live/persisted header conflict anywhere in the observed corpus, or invalid target lineage, fails the whole `list_agents` call because no trustworthy candidate set exists. Only failures after a successful trace are isolated to one candidate; "corrupt child" in that per-child contract therefore means corrupt loaded event surface or descriptor data, not a corpus-level header conflict.

Session lineage is broader than subagent identity: an ordinary `ctx.sessions.fork()` and a one-shot subagent also create direct children. Each candidate must therefore contain exactly one valid `subagent/descriptor` event. The activation contract writes it only during initial creation and cold resume appends no further descriptor; a second event is corruption rather than evidence of another activation. The event distinguishes a continuable background subagent from an ordinary fork or one-shot child; its short creation `label` comes from the delegation's `description`, while its continuation fields remain the reconstruction input for provider-independent cold resume. A candidate without the event is omitted without a diagnostic.

The published logical record is also the status source: `SessionRecord.live` means `running`, while `live: false, persisted: true` means `complete`. `complete` means that no Activation is live; it encodes neither successful completion nor a permanently closed child, and `send_message` may materialize another Activation. Conversely, `running` says only that the session is live: a live Agent outside the continuation manager's matching Activation still appears as `running`, but `send_message` rejects rather than adopting it. A child is not visible before its session is published, and no process-local Activation entry is added as a second candidate or status source. Listing is a snapshot that may race publication, disposal, or a later message; `send_message` remains the authoritative delivery-time operation.

The subagent service keeps `sessionQuery` optional so start and follow-up remain available without it. Its public `listChildren()` method resolves the optional service when called and throws `SubagentError` with stable code `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` before doing any work when it is absent. `@deepseek-ai/dsh-tool-subagent-control` exports separately loadable tool plugins: the `send_message` adapter requires only `subagents`, while the `list_agents` adapter requires both `subagents` and `sessionQuery` at load. A deployment may therefore use `send_message` without loading session query; the list tool catches misconfiguration at plugin load, while another direct service consumer receives the same explicit call-time contract.

This descriptor-read path is the correctness baseline, not a claim that work is linear only in the number of direct children. Let D be the number of direct-child candidates, C the number of persisted sessions scanned by each persistence listing, and L_i the size of candidate i's full log. One corpus trace is followed by two exact reads per candidate. `listChildren()` uses `sessionQuery.listEvents(childId)` to locate the sole descriptor event and `sessionQuery.readEvent({ sessionId: childId, seq })` to read it, and each operation independently loads the logical session. In the persisted-only worst case, every exact read repeats `persistence.list()`, loads the full child log, and clones its events, for O(D × C + Σ L_i) work up to constant factors; a live child instead takes two detached in-memory snapshots of its full log. The persisted path may durably repair an interrupted child log by appending synthetic closing events. The first version accepts the repeated reads as the no-index correctness baseline, but deployments must treat total corpus and child-log size—not only direct-child count—as the capacity constraint. Listing creates no Agent and appends no catalog or descriptor event itself, but it is not a storage-read-only operation. The model-hidden descriptor remains outside the conversation surface and survives compaction, so compacted and uncompacted children must enumerate identically.

If measured scale later requires an index, that index is derived state: session headers and child descriptors remain authoritative, and rebuilding or corruption fallback must reproduce the same results. An index cannot become a second authorization source or make an unpublished child visible.

### `list_agents` contract

`SubagentService.listChildren(parent)` returns every direct continuable child found in the session trace plus non-fatal diagnostics for candidates it could not read or validate. Each child carries its session id, descriptor `label`, and one of two snapshot states:

- `running`: the logical session record is live in `ctx.sessions`;
- `complete`: the logical session record exists only in persistence and may be resumed by `send_message`.

These values are neither `AgentStatus` nor the manager's internal Activation state. Children are sorted by `SessionHeader.createdAt` ascending, then child id ascending; diagnostics follow their candidate's same key. The model-facing `list_agents` tool takes no arguments and is a thin adapter in `@deepseek-ai/dsh-tool-subagent-control` that renders the complete sorted children and diagnostics together.

Diagnostics use three fixed reasons. Malformed event surfaces, conflicting headers discovered during an exact child load, malformed descriptor content, and multiple descriptor events map to `corrupt`. An unknown descriptor version maps to `unsupported`. `SESSION_QUERY_SESSION_NOT_FOUND`, `SESSION_QUERY_EVENT_NOT_FOUND`, and `SESSION_QUERY_PERSISTENCE_FAILED` from a per-child read map to `unavailable`. This phase boundary is intentional: a persistence outage during the initial trace fails the operation, while the same outage beginning during candidate reads may produce one identical `unavailable` diagnostic per affected child; v1 neither coalesces those diagnostics nor promotes them to a global failure. A missing descriptor is instead a one-shot exclusion without a diagnostic. Configuration/window errors and unrecognized failures are not child diagnostics and propagate as operation failures. Each diagnostic identifies the child id and reason without exposing model-hidden descriptor content; the candidate is omitted while healthy siblings remain visible. Sessions outside the trace's direct descendants are never read and produce no diagnostic.

The first version has no child deletion operation. If later product behavior deletes child sessions, persistence listing naturally drops a deleted child; any future derived index must remove or tombstone the same entry so `list_agents` cannot retain stale state.

## Alternatives considered

**Fold listing into the activation RFC.** Descriptor-by-id persistence and cold resume do not require parent-to-child enumeration. Keeping the query separate lets `send_message` land without taking on listing states, scanning performance, or deletion behavior.

**Rebuild lineage directly from `SessionPersistence.list()`.** This duplicates session query's live-preferred corpus merge, immutable-header consistency checks, direct-child tracing, and deterministic ordering. Listing uses the existing trusted query service and adds only subagent-specific descriptor validation and rendering.

**List every traced child session.** `parentSession` proves lineage but does not prove that the child is a continuable subagent: ordinary session forks and one-shot subagents share that header field. Listing must also read and validate the descriptor.

**Use the live Agent registry as the catalog.** Activations are deliberately disposed after settlement, and registry state disappears on restart. It cannot support durable discovery.

**Use the process-local Activation map as a second catalog.** This exposes manager residency but couples a session-discovery query to materialization and settlement, introduces another ordering clock, and makes the same child change candidate source during its lifetime. The first version lists published logical sessions only and treats `SessionRecord.live` as its snapshot status.

**Persist a parent-session catalog event.** Direct-child headers already provide the durable enumeration seed, and the child descriptor is the reconstruction authority. A second parent log duplicates state and creates cross-session ordering and stale-entry behavior without helping by-id resume.

**Fail the whole listing when one child cannot be loaded.** This makes corruption impossible to overlook, but one damaged sibling removes visibility into every healthy child. Per-child diagnostics preserve discovery while keeping each omission explicit.

**Add a repair-free descriptor inspection API.** This would make discovery strictly storage-read-only, but expands the persistence seam solely to avoid the interrupted-tail repair that normal session load and eventual resume already require. The first version accepts `load()` semantics and documents the side effect.

**Paginate or cap the model-facing result.** This bounds one tool result, but makes discovery stateful and can hide older children unless the model follows a cursor. The first version has no arguments and returns the complete stably ordered set; deployments with many durable children accept the corresponding context cost.

## Acceptance criteria

- Enumeration uses `ctx.sessionQuery.traceSession(parent.session.id)`, considers only direct descendants, and does not duplicate corpus merging, lineage reconstruction, or sibling ordering.
- Listing loads no Agent, materializes no Activation, and appends no catalog or descriptor event itself. After the initial trace it performs two independent exact session-query reads per candidate; persisted reads may trigger interrupted-tail repair, and compacted and uncompacted logs return the same children.
- A valid descriptor includes the delegation's durable `label`; ordinary session forks and one-shot children lack that descriptor and are omitted without a diagnostic. Provider registration does not affect discovery or provider-independent cold resume.
- Initial creation writes exactly one descriptor event, cold resume writes none, and a candidate with more than one descriptor event is diagnosed as `corrupt`.
- `list_agents` takes no arguments and returns every valid direct continuable child with its id, label, and `running` or `complete` snapshot state, plus per-child diagnostics, sorted by `createdAt` ascending and child id ascending.
- A live logical session is `running`; a persisted-only logical session is `complete` and remains eligible for a later `send_message`. The result does not consult the process-local Activation map.
- Parent resume does not activate children. A child is absent until its session is published, and listing may race publication, disposal, or later delivery without weakening `send_message`'s execution-time checks.
- `list_agents` uses only `corrupt`, `unsupported`, or `unavailable` diagnostic reasons and never exposes descriptor contents in a diagnostic.
- After a successful initial trace, a corrupt, unsupported, disappeared, or unreadable descriptor candidate cannot hide healthy siblings: it is omitted with an id-and-reason diagnostic. Corpus-level persistence, header-consistency, or lineage failure during that initial trace fails the whole call.
- Per-child session-query failures map deterministically: invalid surfaces and exact-load source conflicts are `corrupt`; missing sessions or events and persistence failures are `unavailable`; unknown descriptor versions are `unsupported`; and missing descriptors are omitted as one-shot children.
- The list tool requires `sessionQuery` at plugin load; a direct `listChildren()` call without it fails before enumeration with `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE`, while by-id `send_message` remains usable without that service.
- Keyless tests cover fresh and compacted discovery, ordinary fork and one-shot exclusion, live-to-complete transition, unmanaged-live-session snapshots, provider-independent discovery, durable `label` values, stable ordering, restart, direct-child tracing, duplicate descriptor rejection, isolated child diagnostics, phase-dependent persistence failure, load repair, snapshot races, and scan behavior. The model-facing complete-list-plus-diagnostics result has runnable snapshot coverage.

## Risks

- Session tracing observes the complete logical corpus, then descriptor validation reads each direct-child log twice. In the persisted-only worst case, work is O(D × C + Σ L_i), not merely O(D), because each exact read rescans persistence and loads and clones the full candidate log. A later derived index must preserve the same authorization, per-child diagnostic, and fallback behavior.
- Corpus construction is an all-or-nothing trust boundary: one live/persisted header conflict can fail the initial trace and hide otherwise healthy siblings. Per-child isolation begins only after that trace succeeds.
- Session-query reads may repair interrupted child logs and persist synthetic closing events even though listing creates no Agent. This is the existing persistence-load contract, not a hidden catalog write.
- The first version has no deletion operation, so persisted children remain listed for as long as their sessions remain in persistence even though live Agent resources remain bounded by resident Activations.
- The no-argument tool returns every direct continuable child and diagnostic. Stable ordering makes the result deterministic but does not bound model-context growth; pagination or deletion remains a later product decision.
- `running` and `complete` are process-local corpus snapshots, not delivery promises. Another process may activate a persisted child while this process reports it as `complete`; cross-process accuracy requires a shared lease.
