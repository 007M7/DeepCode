# Agent Note: Steer a queued Web message into the active turn

Status: implemented

English | [中文](2026-07-30-web-queue-steer-action.zh.md)

## Problem

The Web composer originally queued every Enter submission while an agent ran. QueueDock already gives each pending message an addressable row, and the durable transcript already renders consumed `steering/message` events as user-style bubbles without message actions, but Web had neither an action connecting those two surfaces nor a direct composer gesture for choosing current-turn steering.

Implementing the row action as a client-side delete followed by `session.prompt(mode: 'steer')` would split one user intent across two RPCs. Driver claim could win between them, the steer could fail after deletion, or the existing best-effort `agent.steer()` fallback could silently append a new Queue item after the original occurrence was removed. A send-now action must therefore distinguish current-turn steering from Queue promotion and preserve the original row when steering is no longer possible.

## Decision

### Product contract

Each non-editing QueueDock row exposes the upward-arrow action as “插话发送”. The action is enabled only while the session reports a running agent; mixed-content messages remain eligible because steering forwards the complete immutable `UserMessage` rather than the row's text projection. Edit and delete keep their existing behavior.

Activating the action requests strict current-turn steering for that exact `InboxItemId`. Success removes the Queue row through the authoritative Host snapshot. When AgentLoop drains it, the existing durable `steering/message` event renders the same user-style bubble without a separate durable presentation path.

The running bit is only an interaction hint. AgentLoop's `acceptsNextStep` value is authoritative at the synchronous mutation boundary. If that window has closed, the operation leaves the Queue occurrence unchanged and returns a typed `steer-unavailable` error; if the driver already claimed the occurrence, it returns the existing `queue-item-not-found` error. The UI reports either race without optimistically removing the row.

The composer uses a separate best-effort contract for newly typed input. While the addressed session is idle, Enter and Cmd/Ctrl+Enter both perform an ordinary Queue send. While it is running, a General Settings preference assigns plain Enter to Queue (the default) or Steer, and Cmd/Ctrl+Enter performs the other behavior; Shift+Enter inserts a newline. The browser persists that preference, and it affects only the busy-state gesture pair. If a direct composer Steer misses the current next-step window, AgentLoop automatically admits it as the next waking Queue turn and the Web does not report a failure.

### Agent and lifecycle boundary

`InboxAction` gains a consumer-backed `{ kind: 'steer' }` operation alongside edit and remove. `Agent.updateInbox()` handles it only after locating the queued occurrence and proving `acceptsNextStep`; it never delegates to the best-effort `agent.steer()` alias.

An applied action ends the queued occurrence and accepts the same immutable `UserMessage` as a new steering occurrence. The steering occurrence receives a new `InboxItemId` and truthful `placement: 'steering'`, while the message retains its `MessageId`, content, and source. AgentLoop installs the new outbox entry before publishing lifecycle events, then emits its enqueue before the old occurrence's discard so re-entrant cancellation cannot observe or retire an unannounced item. The existing inbox conservation invariant therefore continues to require one enqueue and one terminal dequeue or discard for each occurrence.

The action does not run `agent/prompt-submit`: choosing steering intentionally changes delivery from an independently admitted turn to current-turn next-step input. It neither cancels current work nor reorders the remaining Queue.

### Host and client boundary

`session.updateQueue` carries the `steer` action and maps the two negative outcomes to typed RPC errors. The conversion is one synchronous Agent operation; the Host never reconstructs it by combining remove and prompt calls.

The Host's existing `queuedMirror` remains the sole transient inbox authority. Its `session/queue` snapshot carries every live occurrence with `placement: 'queued' | 'steering'`: QueueDock renders only queued rows, while ChatView renders pending steering at the conversation tail without edit or delete actions. Reconnect replays the same snapshot, so this visibility does not require client optimism or a second registry.

When AgentLoop claims pending steering, it emits `agent/inbox/dequeue` immediately before synchronously appending `steering/message`. The Host retires that steering row on the following microtask, allowing the durable session event to enter the linear mux stream first. ChatView matches the shared `MessageId` and suppresses the transient projection as soon as the durable node exists, so one bubble changes authority without a visible gap or duplicate; an append failure still retires the claimed row.

The existing `session.prompt(mode: 'steer')` contract remains best-effort for new input: outside the next-step window it becomes a waking follow-up. The composer carries an explicit `queue | steer` mode through slash adjudication and reference serialization before calling that contract. A browser-local submission policy owns the persisted busy-Enter preference and resolves plain versus accelerated Enter as complementary gestures; the Settings row and InputBar share that policy without duplicating storage or delivery-window authority. Only the Queue row action is strict, because failure can safely leave its already-pending message untouched.

### Verification

AgentLoop contract coverage holds prompt admission open, converts one exact queued occurrence, and proves the replacement steering occurrence keeps the message value, drains as `steering/message`, and never starts its former independent turn. It also pins unavailable-window retention, claimed-address rejection, and re-entrant cancellation lifecycle conservation.

Host schema and proxy tests cover the new action, both typed errors, placement-aware snapshots and reconnect replay, plus durable-before-retirement ordering. QueueDock tests cover running-state enablement, complete-content eligibility, failure retention, authoritative success retirement, and filtering of steering occurrences. ChatView tests cover the transient bubble and its single-copy handoff to the durable node.

The keyless Web steering scenario queues a message through the real composer while the first response streams, activates the row arrow, then uses `ask_user_question` as a stable pending-steering barrier. It proves the Host-backed pending bubble appears before admission, hands off to one durable interjection after the answer, and affects the next model request. Assembled composer scenarios prove default-mode Cmd+Enter reaches the same pending and durable path without creating a Queue row, while Steer-mode Cmd+Enter creates a Queue row instead. Settings and submission-policy coverage pin the default, persistence, busy-only scope, and complementary gesture mapping; Queue edit/delete scenarios continue to prove those actions are unchanged.

## Alternatives considered

**Delete the row, then call `session.prompt(mode: 'steer')` from Web.** Rejected because two RPCs cannot make deletion and steering atomic; failure and driver-claim races can lose or duplicate the user's message.

**Restore Queue promotion under the upward arrow.** Rejected because moving an item to the front still creates an independent admitted turn. The control promises current-turn steering, not priority within Queue.

**Use the existing best-effort `agent.steer()` behavior for the Queue row.** Rejected for that action because a closed next-step window would silently turn the selected row back into queued work, possibly at a different position and identity. Strict failure preserves the original occurrence and makes the semantic race visible. Newly typed composer input has no existing Queue occurrence to preserve, so it intentionally uses the best-effort behavior.

**Change `agent.steer()` to be strict for every caller.** Rejected because TUI and plugin callers use its safe follow-up fallback for newly submitted input. A queued row has recoverable state that those callers do not.

**Preserve the same `InboxItemId` while changing placement.** Rejected because `InboxItemId` identifies one FIFO acceptance and `placement` records that acceptance's resolved delivery. Ending one queued occurrence and accepting one steering occurrence keeps lifecycle facts truthful and leaves the conservation invariant unchanged.

**Add a dedicated pending-steering projection and client store.** Rejected because queued and steering occurrences already share one Agent inbox lifecycle and one Host mirror. A second projection would duplicate reconnect state and ordering authority; a placement tag lets each client surface select its rows without widening Queue mutation semantics.

**Cancel the active turn and run the selected Queue item.** Rejected because it destroys unrelated in-flight work and starts a new turn rather than steering the current one.

## Consequences

`session/queue` describes a placement-aware transient inbox snapshot rather than a Queue-only list, so every consumer must filter by placement. Pending steering survives reconnect and appears immediately, but remains non-durable until `steering/message` commits. The running bit can also remain true briefly after the strict next-step window closes, so the button may be enabled for an operation that correctly returns `steer-unavailable`.

The explicit action changes delivery from an independently admitted turn to current-turn steering, so prompt-admission plugins do not process the converted message. Enqueue-before-discard lifecycle publication remains required for re-entrant cancellation safety; focused regression coverage protects that ordering.
