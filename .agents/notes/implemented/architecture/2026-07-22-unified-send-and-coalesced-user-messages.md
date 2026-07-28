# Agent Note: Unify agent delivery on send(target × wakeup) and coalesce injected context into user/message

Status: implemented

English | [中文](2026-07-22-unified-send-and-coalesced-user-messages.zh.md)

## Problem

The agent's public driving surface had grown three near-parallel verbs — `send`, `steer`, `inject` — each with its own options type, its own live event story, and its own durable event. `send` and `steer` both queued a frozen inbox record and emitted `agent/queued`; `inject` bypassed the inbox and wrote a separate `context/message` durable event. The three verbs actually vary along only two independent axes: which queue an item joins (a whole new turn versus the active turn) and whether the item makes the model run. Encoding that 2×2 as three hand-written methods hid the symmetry, made "queue a turn without waking the driver" unreachable, and left `cancel()` with no way to abort a turn while preserving queued work.

Separately, `context/message` and `user/message` had converged: the surface projected both as verbatim user-role content, and the only real difference was that injected context carried a non-user `source` and was "not a prompt." Two event types for one projection meant every consumer branched on event type to answer "is this a human prompt?", and the goal system used the type split as a side channel (round-zero state changes were `context/message`, admitted rounds were `user/message`).

## Decision

**One primitive, three preset aliases.** The `Agent` interface's `send(message, { target, wakeup })` covers the (`target` × `wakeup`) matrix. Its complete `UserMessage` owns identity, role, model-facing `content`, and producer `source`; the complete `SendOptions` owns only routing policy. `followup` (`next-turn`/wakeup), `steer` (`next-step`/wakeup), and `inject` (`next-step`/no-wakeup) each accept that one message and fix the policy. `wakeup` means "make the model run": wake a parked driver for a `next-turn` item, or force a continuation for a running `next-step` item. `next-turn`/no-wakeup (queue without waking) is representable with no alias and no current caller.

**inject keeps its mechanism.** The `next-step`/no-wakeup path is exactly the old `inject`: durable model-facing context appended at the current log position, deferred while prompt admission or a turn owns the next safe boundary, and appended directly outside that window. It bypasses the FIFOs entirely, while its required `UserMessage.source` preserves the caller's explicit provenance.

**context/message is gone.** Injected context is now a `user/message`; context producers supply the appropriate non-user `source` explicitly, and typed source variants carry any domain-specific durable provenance. The surface, derivation, and `SurfaceEventType` drop `context/message`; consumers that need "is this a human prompt?" read `source.kind === 'user'` instead of the event type.

**Goal replay disambiguates by round, not type.** A goal state change is a round-zero goal-sourced `user/message` whose source carries the complete change; a positive round is an admitted continuation prompt. `decodeGoalEvent` takes a `user/message` and fails loud when goal-state content and its typed source disagree.

**`send` does not return identity.** Callers already own the complete message and its opaque `MessageId`; creation and freezing are owned by the [identified immutable message decision](2026-07-28-identified-immutable-message-values.md), not by routing.

**Three inbox events replace agent/queued.** `agent/inbox/enqueue` (an item entered a FIFO), `agent/inbox/dequeue` (the driver claimed one), and `agent/inbox/discard` (`cancel()` dropped pending items) carry the accepted `UserMessage`. Enqueue and dequeue also carry the resolved `queued | steering` placement captured at acceptance, so observers and reconnect mirrors retire repeated message identities from the correct FIFO without reconstructing routing from later status or session history. Injection never touches a FIFO and emits none of these. Every FIFO entry publishes an enqueue, including steering submitted by an `agent/turn-stopping` listener, so the ledger stays balanced with its later dequeue or discard. The `dsh-agent` invariant companion asserts FIFO conservation: a per-agent outstanding count that dequeue and discard can never drive negative.

**Admission accepts next-step input without becoming a turn.** The loop opens a private next-step acceptance window before `agent/prompt-submit`, keeps it open through the turn, and closes it before `turn/end`. Steering and injection received during admission therefore remain together in the outbox and join an allowed turn. If admission blocks or fails, a context-only caller batch takes idle injection's immediate append, while steering and context staged beside it remain available to retry; neither path writes the rejected prompt. When a later prompt is admitted, retained outbox input enters its turn before that prompt, while input accepted during the current admission remains after the prompt. Closing the window before `turn/end` preserves the rule that reentrant late steering becomes an independent queued turn. `Agent.acceptsNextStep` exposes whether a `next-step` send would currently join this window; `status` remains the broader activity signal rather than a routing predicate.

**One accepted message keeps one representation.** Durable user-role input and additional model-facing context both use the identified, frozen `UserMessage` directly. The loop stores that value beside private routing state rather than copying its identity, content, or source into another public shape. A queued message that becomes steering keeps the same message value in the outbox, while injected and tool-produced context each carry their own identified message. The [identified immutable message decision](2026-07-28-identified-immutable-message-values.md) supersedes this note's former `UserMessageData`/`AgentMessage` hierarchy and extends the representation to assistant and tool-result messages.

**Idle wakeup follows acceptance.** Before publishing enqueue, a waking queued send installs quiescence ownership and schedules driver admission for a microtask that runs after the id returns. Every send in one synchronous caller stack therefore resolves placement against the same pre-admission state, while reentrant cancellation or teardown cannot retire before the scheduled admission settles. Two idle `steer()` calls remain two FIFO turns instead of the first opening an admission window that captures the second.

**cancel gains keepInbox.** `cancel(cause, { keepInbox? })`; callers choose the cause explicitly, and `keepInbox: true` aborts the active turn while preserving queued and steering items (no discard event, and un-started work is not dropped).

## Alternatives considered

- **A dedicated `MessageSource` kind `context`** for injected content. Rejected because `plugin` already means "not a human," so a fourth kind would add a parallel axis the authority checks would have to learn. Plugin-produced injected context supplies its plugin source explicitly.
- **A typed discriminant field on `UserMessage`** (e.g. `origin: 'prompt' | 'context'`) to replace the event-type split. Rejected in favor of `source`, which every consumer already carries and which the goal system already keyed on; a second discriminant would duplicate that fact.
- **Keeping `agent/queued` alongside the inbox events.** Rejected as a mirror: `agent/inbox/enqueue` is the same enqueue-time signal with the resolved placement, and the dequeue/discard events complete the FIFO lifecycle the single event could not describe.
- **Derive inbox placement from agent status or the session log.** Rejected because `running` includes admission and settlement, while reconnect baselines need the original acceptance result even when the earlier turn boundary is absent. The producer already owns the exact routing decision.

## Consequences

The delivery surface is now one primitive plus three self-documenting presets, and the (`target` × `wakeup`) matrix makes previously-unreachable combinations explicit. One durable message type serves prompts, injected context, and goal rounds, so the surface projection and every "human prompt?" check simplify to a `source` test. The `Agent` contract remains an interface, so alternate implementations and object-literal test fakes implement the same minimal structural surface. The goal fold's channel split moved from event type to `source.round`, and every consumer that filtered `context/message` now filters `user/message` by source. An idle injection appends `user/message` between turns without opening a turn or running the model.

`wakeup` is the "should the model run" signal, so the inbox distinguishes waking queued work from anything available to dequeue: a lone `next-turn`/no-wakeup item stays parked at idle and rides along the next waking send, and `whenIdle`/`cancel` settle quiescence off the waking signal. Every FIFO exit publishes exactly one lifecycle event, while domain-specific durable facts travel in typed message sources rather than a parallel metadata channel. The direct pending-item representation keeps public lifecycle events correlated without maintaining a second steering wrapper or allowing its durable data to diverge.

## Related

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md) — the one-claimed-message-per-turn rule this builds on.
- [remove-agent-steering-mirror](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md) — the precedent for collapsing a mirrored live event.
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md) — the cancel-cause signal `keepInbox` extends.
- [identified immutable message values](2026-07-28-identified-immutable-message-values.md) — the message identity and representation contract that now underlies this routing decision.
