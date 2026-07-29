# Agent Note: Steer a queued Web message into the active turn

Status: implemented

English | [中文](2026-07-30-web-queue-steer-action.zh.md)

## Problem

The Web composer deliberately queues Enter submissions while an agent runs. QueueDock already gives each pending message an addressable row, and the durable transcript already renders consumed `steering/message` events with an interjection badge, but Web has no action connecting those two surfaces.

Implementing the row action as a client-side delete followed by `session.prompt(mode: 'steer')` would split one user intent across two RPCs. Driver claim could win between them, the steer could fail after deletion, or the existing best-effort `agent.steer()` fallback could silently append a new Queue item after the original occurrence was removed. A send-now action must therefore distinguish current-turn steering from Queue promotion and preserve the original row when steering is no longer possible.

## Decision

### Product contract

Each non-editing QueueDock row exposes the upward-arrow action as “插话发送”. The action is enabled only while the session reports a running agent; mixed-content messages remain eligible because steering forwards the complete immutable `UserMessage` rather than the row's text projection. Edit and delete keep their existing behavior, and the composer continues to submit Enter as Queue.

Activating the action requests strict current-turn steering for that exact `InboxItemId`. Success removes the Queue row through the authoritative Host snapshot. When AgentLoop drains it, the existing durable `steering/message` event and transcript badge render the message without a new chat presentation path.

The running bit is only an interaction hint. AgentLoop's `acceptsNextStep` value is authoritative at the synchronous mutation boundary. If that window has closed, the operation leaves the Queue occurrence unchanged and returns a typed `steer-unavailable` error; if the driver already claimed the occurrence, it returns the existing `queue-item-not-found` error. The UI reports either race without optimistically removing the row.

### Agent and lifecycle boundary

`InboxAction` gains a consumer-backed `{ kind: 'steer' }` operation alongside edit and remove. `Agent.updateInbox()` handles it only after locating the queued occurrence and proving `acceptsNextStep`; it never delegates to the best-effort `agent.steer()` alias.

An applied action ends the queued occurrence and accepts the same immutable `UserMessage` as a new steering occurrence. The steering occurrence receives a new `InboxItemId` and truthful `placement: 'steering'`, while the message retains its `MessageId`, content, and source. AgentLoop installs the new outbox entry before publishing lifecycle events, then emits its enqueue before the old occurrence's discard so re-entrant cancellation cannot observe or retire an unannounced item. The existing inbox conservation invariant therefore continues to require one enqueue and one terminal dequeue or discard for each occurrence.

The action does not run `agent/prompt-submit`: choosing steering intentionally changes delivery from an independently admitted turn to current-turn next-step input. It neither cancels current work nor reorders the remaining Queue.

### Host and client boundary

`session.updateQueue` carries the `steer` action and maps the two negative outcomes to typed RPC errors. The conversion is one synchronous Agent operation; the Host never reconstructs it by combining remove and prompt calls.

The Host's transient `session/queue` projection remains Queue-only. It ignores the new pending steering occurrence and removes the old row when its discard arrives. Pending steering does not gain edit, delete, or reconnect presentation in this cut. A later dedicated pending-steering projection may add that observability without widening Queue mutation semantics.

The existing `session.prompt(mode: 'steer')` contract remains best-effort for new input: outside the next-step window it may become a waking follow-up. Only the Queue row action is strict, because failure can safely leave its already-pending message untouched.

### Verification

AgentLoop contract coverage holds prompt admission open, converts one exact queued occurrence, and proves the replacement steering occurrence keeps the message value, drains as `steering/message`, and never starts its former independent turn. It also pins unavailable-window retention, claimed-address rejection, and re-entrant cancellation lifecycle conservation.

Host schema and proxy tests cover the new action, both typed errors, authoritative Queue snapshots, and the absence of pending steering from reconnect snapshots. QueueDock tests cover running-state enablement, complete-content eligibility, failure retention, and authoritative success retirement.

The keyless Web steering scenario queues a message through the real composer while the first response streams, activates the row arrow, then uses `ask_user_question` as a stable pending-steering barrier. After the answer, it proves one badged interjection becomes durable and the next model request obeys it. Queue edit/delete scenarios continue to prove those actions are unchanged.

## Alternatives considered

**Delete the row, then call `session.prompt(mode: 'steer')` from Web.** Rejected because two RPCs cannot make deletion and steering atomic; failure and driver-claim races can lose or duplicate the user's message.

**Restore Queue promotion under the upward arrow.** Rejected because moving an item to the front still creates an independent admitted turn. The control promises current-turn steering, not priority within Queue.

**Use the existing best-effort `agent.steer()` behavior.** Rejected for this action because a closed next-step window would silently turn the selected row back into queued work, possibly at a different position and identity. Strict failure preserves the original occurrence and makes the semantic race visible.

**Change `agent.steer()` to be strict for every caller.** Rejected because TUI and plugin callers use its safe follow-up fallback for newly submitted input. A queued row has recoverable state that those callers do not.

**Preserve the same `InboxItemId` while changing placement.** Rejected because `InboxItemId` identifies one FIFO acceptance and `placement` records that acceptance's resolved delivery. Ending one queued occurrence and accepting one steering occurrence keeps lifecycle facts truthful and leaves the conservation invariant unchanged.

**Expose pending steering in `session/queue`.** Deferred because the existing product design provides no pending-steering row state or operations. Authoritative Queue retirement plus the durable consumed bubble is sufficient for the first interaction cut; reconnect visibility can be added through a dedicated projection if product testing shows the gap matters.

**Cancel the active turn and run the selected Queue item.** Rejected because it destroys unrelated in-flight work and starts a new turn rather than steering the current one.

## Consequences

A successful action can be pending but absent from the Web after its Queue row retires and before `steering/message` commits; a refresh during that interval has no pending-steering indication. The running bit can also remain true briefly after the strict next-step window closes, so the button may be enabled for an operation that correctly returns `steer-unavailable`.

The explicit action changes delivery from an independently admitted turn to current-turn steering, so prompt-admission plugins do not process the converted message. Enqueue-before-discard lifecycle publication remains required for re-entrant cancellation safety; focused regression coverage protects that ordering.
