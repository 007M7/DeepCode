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
- exclude sessions that are one-shot, corrupt, unsupported, missing, or not direct children;
- overlay the process-local Task association without treating it as durable state.

Descriptor format, persistence, by-id lookup, direct-parent authorization, and cold resume remain owned by the activation proposal. Listing consumes those facts but cannot weaken them or invent a second descriptor representation.

### Enumeration decision

The first implementation uses `SessionPersistence.list()` to obtain materialized headers, filters on `SessionHeader.parentSession`, and calls `load()` only for those direct-child candidates to fold their descriptors. The activation contract calls a preallocated id without a durable header and descriptor an **unmaterialized child**: by-id control reports it as unavailable, while persistence listing omits it. A materialized one-shot child lacks the descriptor and is excluded. This path requires no parent-session catalog event or new persistence backend.

This O(number of direct children) load path is the correctness baseline. If measured scale later requires an index, that index is derived state: session headers and child descriptors remain authoritative, and rebuilding or corruption fallback must reproduce the same results. An index cannot become a second authorization source or make an unmaterialized child visible.

Listing adds no session event and no surface node. It reads the model-hidden descriptor retained in the child log by the activation contract, so compacted and uncompacted children must enumerate identically.

### `list_agents` contract

`SubagentControlService.listChildren(parent)` returns only durable direct children that carry a valid continuable descriptor, then overlays the process-local Task association. The model-facing `list_agents` tool is a thin adapter in `@deepseek-ai/dsh-tool-subagent-control` and reports two operational states:

- `running`: a non-terminal Task-backed activation exists, including startup and settlement before Task terminal publication;
- `resumable`: a valid durable descriptor exists and no activation is associated.

These values are not `AgentStatus`. A plain Agent registry entry without a Task association is an ownership conflict, not a third list state. Corrupt, unsupported-version, wrong-parent, or missing-child descriptors fail explicitly rather than being silently advertised as resumable.

The first version is read-only and has no child deletion operation. If later product behavior deletes child sessions, persistence listing naturally drops a deleted child; any future derived index must remove or tombstone the same entry so `list_agents` cannot retain stale state.

## Alternatives considered

**Fold listing into the activation RFC.** Descriptor-by-id persistence and cold resume do not require parent-to-child enumeration. Keeping the query separate lets `send_message` land without taking on listing states, scanning performance, or deletion behavior.

**List every persisted session whose header names the parent.** `parentSession` proves lineage but does not prove that the child is continuable. Listing must also load and validate the descriptor.

**Use the live Agent registry as the catalog.** Runs are deliberately disposed after every Task, and registry state disappears on restart. It cannot support durable discovery.

**Persist a parent-session catalog event.** Direct-child headers already provide the durable enumeration seed, and the child descriptor is the reconstruction authority. A second parent log duplicates state and creates cross-session ordering and stale-entry behavior without helping by-id resume.

## Acceptance criteria

- Enumeration uses materialized session headers as candidates, validates `parentSession`, and includes only children whose persisted descriptor satisfies the durable child-handle contract.
- Listing loads no Agent, appends no session event, and returns the same children from compacted and uncompacted logs.
- `list_agents` returns only valid direct continuable children and reports `running` or `resumable`, with no pass-through runtime status.
- Parent resume does not activate children; listing reads durable state and overlays only already-associated process-local Tasks.
- A preallocated-but-unmaterialized child id, one-shot child, corrupt descriptor, unsupported descriptor version, wrong-parent child, and stale derived-index entry are never advertised as resumable.
- Keyless tests cover fresh and compacted discovery, restart, wrong-parent access, unsupported descriptors, scan behavior, and stale-index fallback. The model-facing tool has runnable snapshot coverage.

## Risks

- Listing performs one header scan and may load every direct-child log; a later derived index must preserve the same authorization, corruption, and fallback behavior.
- The first version has no deletion operation, so persisted children remain listed for as long as their sessions remain in persistence even though live Agent resources remain bounded by active Tasks.
- Task associations exist only in one runtime. Another process can report a durable child as `resumable` while work for that child is active elsewhere unless the deployment adds a shared lease.
