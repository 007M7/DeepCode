# Agent Note: Address pending queue occurrences for edit and removal

Status: implemented

English | [中文](2026-07-29-addressable-queue-operations.zh.md)

## Problem

The Web queue rendered pending messages but could not edit or delete one row. `MessageId` was insufficient as an address because callers may enqueue the same immutable message more than once. The browser also inferred queue retirement from turn and status events, so a row operation racing with driver claim had no authoritative outcome.

## Decision

**Each accepted FIFO occurrence has its own identity.** AgentLoop mints an opaque `InboxItemId` and publishes an `InboxItem` containing that id, the identified `UserMessage`, and its acceptance-time `queued | steering` placement. Reusing one `MessageId` creates distinct inbox identities. Injection bypasses the FIFOs and receives no inbox identity.

**Mutation ends at driver claim.** `Agent.updateInbox(id, action)` synchronously searches the pending queued FIFO. Edit replaces frozen content while preserving `InboxItemId`, `MessageId`, source, wake policy, and position. Remove emits the occurrence’s terminal discard. Strict steer transfers the message into an open next-step window as a new steering occurrence; a closed window returns `steer-unavailable` without changing the queued item. Pending steering and driver-claimed occurrences return `not-found`, so later mutations never rewrite active-turn input or durable history.

**The live ledger is authoritative.** `agent/inbox/enqueue`, `update`, `dequeue`, and `discard` maintain a Host mirror of queued occurrences. A synchronously re-entrant update or terminal event may reach the mirror before its outer enqueue listener; the mirror retains that unseen outcome for the current dispatch and folds it into the enqueue, so listener registration order cannot publish stale content or a ghost row. The wire sends complete `session/queue` snapshots rather than incremental guesses. Reconnect sends the current baseline, and every queued mutation or terminal event replaces it. The client applies no optimistic edit and never retires a row from durable turn events or status changes.

**Queue addresses require a live ordinary-session Agent.** `session.updateQueue` queries only the mounted Agent registry and never resumes a cold session: an `InboxItemId` is process-local and cannot name work after restart or disposal. A session-backed subagent returns `agent-busy` before inbox access and retains its continuation owner; for ordinary sessions, a missing Agent and a driver-claimed occurrence both return `queue-item-not-found`.

**Web actions address Queue only.** The placement-aware `session/queue` snapshot carries both queued and pending-steering occurrences; QueueDock selects only queued items, while ChatView projects steering and retains the existing durable transcript path after consumption. QueueDock hides while empty, renders one pending occurrence directly, and defaults two or more occurrences to a collapsed `"<n> 条排队消息"` header that expands or collapses the complete list. The header exposes `aria-expanded` and `aria-controls`; the expanded list scrolls within a 180px height bound. An active edit or mutation keeps its rows visible, and emptying the queue restores the collapsed default for the next queue. Visible rows expose edit, delete, and a running-only strict-steer action. The UI derives queue row and mutation types from the runtime `SessionFace` contract rather than importing the connection plugin, so plugin cooperation continues through services and snapshots. Edit is available only when all content blocks are text; the editor cannot silently drop non-text blocks. An editing row exposes only save and cancel, with Enter and Escape as their keyboard equivalents. Delete removes the exact occurrence, while strict steer preserves every content block and retires the row only through the authoritative snapshot. The Web stop action preserves pending Queue work; AgentLoop claims the next waking occurrence only after the interrupted turn reaches quiescence, and its dequeue event retires that row without a browser resend. The [Web Queue steer action](2026-07-30-web-queue-steer-action.md) owns the strict transfer and pending-projection contract.

## Alternatives considered

**Address rows by `MessageId`.** Rejected because one immutable message may be sent repeatedly; editing or deleting by message identity would affect an ambiguous occurrence.

**Apply optimistic browser mutations.** Rejected because driver claim and another client can win before the Host action. Waiting for the authoritative snapshot makes the ownership boundary visible and lets `queue-item-not-found` report a real race.

**Allow editing or removal of pending steering.** Rejected because QueueDock only addresses independent queued turns. Once strict steer succeeds, the new steering occurrence belongs to the active turn and remains outside this mutation surface.

**Expose a protocol-only promotion operation.** Rejected because no product interaction reorders Queue. A public operation without a current consumer would add ordering semantics and tests for speculative use.

**Resume a cold Agent for a queue operation.** Rejected because durable session identity does not preserve the process-local inbox capability. Resuming can only produce `not-found` after creating unrelated live state.

## Verification

AgentLoop contract tests hold prompt admission while editing, removing, and strictly steering exact queued occurrences; they reject mutations of steering occurrences and verify the resulting independent turn and terminal lifecycle events. Host schema and proxy tests cover queued-only authoritative snapshots, synchronous re-entrant mutation order, reconnect, cold-Agent rejection, typed race errors, and the RPC transport. Client runtime and QueueDock tests cover non-optimistic projection, single-row presentation, default multi-row collapse, interaction-forced visibility, reset after emptying, expansion, text-only editing, save and cancel affordances, removal, strict steer, retirement races, and disabled mixed-content editing. Keyless browser scenarios drive all three exposed actions through the built Web composition and real HTTP/SSE wire, then stop consecutive active turns to prove the preserved FIFO advances without clearing its tail.

## Consequences

Queued work gains precise row operations without becoming durable session history. Occurrence identity is a live process-local capability and disappears at claim, strict transfer, broad cancellation, disposal, or restart; the Web stop action preserves queued occurrences until a later claim, while reconnect recovers only queued items still held by the live Agent. Editing excludes mixed content until an editor can preserve every block, while pending steering remains outside the projection and operation surface.

The protocol now carries full queue snapshots on each change. Queues are expected to remain short, so deterministic recovery and multi-client convergence are preferred over an incremental mutation protocol.
