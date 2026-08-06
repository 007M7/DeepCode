# Agent Note: Continuable subagent current-turn interrupt

Status: implemented

English | [中文](2026-08-06-continuable-subagent-interrupt.zh.md)

## Problem

A running continuable subagent could not be stopped without destroying it. The continuation manager cancels child Agents only inside whole-Activation teardown (settlement, drain, scoped drain), `send_message`/`subagent.prompt` only add work, and the Web composer's Stop button was deliberately limited to ordinary sessions. A human watching a continuable child burn tokens on a wrong path had no lever short of killing the parent tree, and when the direct parent Agent was offline the child was entirely untouchable even though its Activation stayed live. One-shot runs have holder-owned disposal and task-kill; continuable children had no analogous current-turn control.

## Decision

`ctx.subagents.interrupt(targetSessionId, authority)` stops only the live target's current turn. The manager primitive authorizes synchronously, calls the existing `Agent.cancel(cause, { keepInbox: true })`, and returns `void` — fire-and-return: the cancel signal is guaranteed issued, target quiescence is not awaited. Nothing else changes: no Activation disposal, no handle release, no descendant cascade, no inbox clearing, and no `AgentLoop` or `CancelOptions` change. Because `keepInbox` parks the pending queue at idle, an interrupt never auto-starts the next queued follow-up; only a later explicit waking send resumes the preserved FIFO order.

Authority is a closed two-variant union, deliberately wider than delivery authority because stopping a turn is idempotent and delivers no content:

- `{ kind: 'user', parentSessionId }` — a human presents the durable direct-parent address. The live target's `session.header.parentSession` must match; no live parent Agent, catalog read, or persistence access is involved, which is exactly what keeps a live child stoppable while its parent Agent is offline. Cancel cause `user`.
- `{ kind: 'ancestor', agent }` — an exact live ancestor Agent (direct parent or deeper). The caller must be the registry's current entry for its id (stale callers are rejected even for absent targets), must not be the target itself, and must appear in the Activation's materialization-time `ancestry` WeakSet. Cancel cause `parent`.

Targets are resolved only in the manager's process-local Activation map. An absent id — unknown, one-shot, or naturally settled — is an accepted no-op, which uniformly covers completion races and repeat requests without leaking durable-catalog information; a target whose disposal transaction is already open is likewise an accepted no-op after authorization. One-shot lifecycle (holder `dispose()`, task-kill) is untouched. `SubagentService.interrupt()` treats a manager-less composition as an accepted no-op rather than `CONTINUATION_UNAVAILABLE`, because without a manager no manager-owned live Activation can exist.

The Host RPC `subagent.interrupt` takes the continuable `SubagentAddress` and returns `{ accepted: true }`. Its implementation calls only the core primitive with `user` authority — deliberately no `catalogChild()`, `listChildren()`, `sessionQuery`, or parent-registry lookup. A live target with a mismatched parent address maps to `subagent-unauthorized`; unexpected failures map to `internal` without leaking error text onto the wire.

## Alternatives considered

**Route human interrupts through `session.cancel`.** The generic session cancel requires an attached ordinary session and rejects subagent-owned sessions; widening it would entangle subagent authority rules with ordinary session routing. A subagent-domain RPC keeps the address-based authorization and the parent-offline guarantee explicit.

**Await target quiescence and return the turn outcome.** Cancellation is cooperative, so quiescence is unbounded; holding the RPC (and a `ChildLock` slot) open invites timeouts and convoying against delivery and disposal. Acceptance-of-signal is the only fact the caller needs, and races (natural completion, disposal) already settle idempotently.

**Reuse whole-Activation disposal for interrupt.** Disposal cancels without `keepInbox`, flushes, captures, and releases the handle — it destroys queued work and the child's residency. Interrupt is a control operation on one turn, not a lifecycle operation on the Activation.

**Extend `send_message`/`followup` authority to ancestors while at it.** Delivery injects content into a conversation and is not idempotent; its exact-direct-parent authority stays unchanged. Only interrupt gets the wider ancestor and address-based user authority.

**Auto-resume the parked queue after an interrupt.** Immediately starting queued follow-up B after aborting A would make the interrupt look ignored and steal the human's window to redirect the child. Parking until an explicit waking send keeps the stop observable and the FIFO order intact.

## Consequences

A human or ancestor can now stop a runaway continuable turn without losing the child, its queued work, or its running descendants; the cost is a deliberately weak postcondition (`accepted` means "signal issued", so a target may remain visibly `running` until it observes the signal) that clients must render honestly. The parked-queue rule means an interrupted child sits idle with retained work until someone sends a waking message — an intentional human-in-the-loop pause, not a scheduler defect. The Web Stop action and the model-facing `interrupt_agent` tool build on this primitive in the stacked follow-up PRs for issue #1535.

## Testing

Core coverage in `packages/subagent/subagent/tests/continuation.spec.ts` proves the durable `turn/end` abort, parked-then-FIFO-resumed queue, untouched descendant, both authority kinds with their cancel causes, self/sibling/stale/non-ancestor rejection, absent/one-shot/disposal-race no-ops, and the unchanged `keepInbox` loop behavior. Host coverage in `packages/host/apiproxy/tests` proves the RPC calls only the core primitive (no agents/catalog/history reads), the `subagent-unauthorized`/`internal` mappings, the wire schema's continuable-mode fence, and carrier round-trips.
