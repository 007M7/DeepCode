# Agent Note: Address pending queue occurrences for edit, remove, and promotion

Status: implemented

English | [中文](2026-07-29-addressable-queue-operations.zh.md)

## Problem

The Web queue rendered pending messages but could not act on one row. `MessageId` was insufficient as an address because callers may enqueue the same immutable message more than once. The browser also inferred queue retirement from turn and status events, so a row operation racing with driver claim had no authoritative outcome.

“Send now” introduced a separate semantic choice: it could mean reorder the next independent turn, interrupt the current turn as steering, or cancel current work. Only the first interpretation preserves the queue row’s original delivery contract.

## Decision

**Each accepted FIFO occurrence has its own identity.** AgentLoop mints an opaque `InboxItemId` and publishes an `InboxItem` containing that id, the identified `UserMessage`, and its acceptance-time `queued | steering` placement. Reusing one `MessageId` creates distinct inbox identities. Injection bypasses the FIFOs and receives no inbox identity.

**Mutation ends at driver claim.** `Agent.updateInbox(id, action)` synchronously searches the pending queued and steering FIFOs. Edit replaces frozen content while preserving `InboxItemId`, `MessageId`, source, placement, wake policy, and position. Remove emits the occurrence’s terminal discard. Promote moves it to the front of its current FIFO; an ordinary queued item also becomes waking. The driver removes an occurrence before prompt admission or steering drain, so a later mutation returns `not-found` and never rewrites durable history.

**The live ledger is authoritative.** `agent/inbox/enqueue`, `update`, `dequeue`, and `discard` maintain a Host mirror. The wire sends complete `session/queue` snapshots rather than incremental guesses. Reconnect sends the current baseline, and every live mutation or terminal event replaces it. The client applies no optimistic edit and never retires a row from `turn/start`, `steering/message`, or status changes.

**Web actions preserve delivery kind.** QueueDock projects only `queued` occurrences; pending `steering` occurrences remain in the authoritative snapshot but wait for a dedicated Web interaction. It exposes edit and delete, but no send-now control. Edit is available only when all content blocks are text; the editor cannot silently drop non-text blocks. An editing row exposes only save and cancel, with Enter and Escape as their keyboard equivalents. Delete removes the exact occurrence. Protocol-level promotion remains available without being presented as a Web interaction; it never converts queued work into steering or cancels active work.

## Alternatives considered

**Address rows by `MessageId`.** Rejected because one immutable message may be sent repeatedly; editing or deleting by message identity would affect an ambiguous occurrence.

**Apply optimistic browser mutations.** Rejected because driver claim and another client can win before the Host action. Waiting for the authoritative snapshot makes the ownership boundary visible and lets `queue-item-not-found` report a real race.

**Treat send-now as steering.** Rejected because it would change a queued independent turn into current-turn context, bypass ordinary prompt admission, and alter the one-send-one-turn guarantee. Promotion changes priority, not delivery semantics.

**Cancel the active turn before promotion.** Rejected because a row-local action must not destroy unrelated in-flight work.

## Verification

AgentLoop contract tests hold prompt admission while editing, removing, and promoting exact occurrences, then verify the resulting independent-turn order and terminal lifecycle events. Host schema and proxy tests cover authoritative snapshots, reconnect, typed not-found errors, and the RPC transport. Client runtime and QueueDock tests cover non-optimistic projection, queued-only Web projection, text-only editing, save and cancel affordances, removal, retirement races, disabled mixed-content editing, and the absent send-now control. Keyless browser scenarios drive the exposed edit and delete actions and keep accepted pending steering hidden until it becomes a durable transcript event through the built Web composition and real HTTP/SSE wire.

## Consequences

Pending work gains precise row operations without becoming durable session history. Occurrence identity is a live process-local capability and disappears at claim, cancellation, disposal, or restart; reconnect recovers only items still held by the live Agent. Send-now is intentionally weaker than interruption, and editing intentionally excludes mixed content until an editor can preserve every block.

The protocol now carries full queue snapshots on each change. Queues are expected to remain short, so deterministic recovery and multi-client convergence are preferred over an incremental mutation protocol.
