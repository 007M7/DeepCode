# Agent Note: Unify agent delivery and coalesce injected context into user/message

Status: implemented

English | [中文](2026-07-22-unified-send-and-coalesced-user-messages.zh.md)

## Problem

The agent's public driving surface had grown three near-parallel verbs — `send`, `steer`, `inject` — each with its own options type, its own live event story, and its own durable event. `send` and `steer` both queued a frozen inbox record and emitted `agent/queued`; `inject` bypassed the inbox and wrote a separate `context/message` durable event. The three verbs actually vary along only two independent axes: which queue an item joins (a whole new turn versus the active turn) and whether the item makes the model run. Encoding that 2×2 as three hand-written methods hid the symmetry, made "queue a turn without waking the driver" unreachable, and left `cancel()` with no way to abort a turn while preserving queued work.

Separately, `context/message` and `user/message` had converged: the surface projected both as verbatim user-role content, and the only real difference was that injected context carried `source`/`meta` and was "not a prompt." Two event types for one projection meant every consumer branched on event type to answer "is this a human prompt?", and the goal system used the type split as a side channel (round-zero state changes were `context/message`, admitted rounds were `user/message`).

## Decision

**One acceptance mechanism, four intent helpers.** The concrete loop resolves `followup`, `queue`, `steer`, and `inject` into one (`target` × `wakeup`) acceptance mechanism. `followup` is `next-turn`/wakeup, `queue` is `next-turn`/no-wakeup, `steer` is `next-step`/wakeup, and `inject` is `next-step`/no-wakeup. The public structural interface exposes that mechanism as `send(ResolvedAgentInput)` for callers that already have fully resolved routing; every field is mandatory, and the discriminated input type excludes attached contexts from injection. The [intent-named delivery decision](2026-07-24-intent-named-agent-delivery.md) owns that superseding interface choice. Internally, `wakeup` means “make the model run”: wake a parked driver for an ordinary item or force a continuation for running steering.

**inject keeps its mechanism.** `inject` appends durable model-facing context at the current log position (deferred behind an executing tool batch), or opens a one-shot `injection` turn when idle. It bypasses the FIFOs entirely, accepts no attached contexts, and defaults its source to `{ kind: 'plugin', plugin: '' }`, never `{ kind: 'user' }`.

**context/message is gone.** Injected context is now a `user/message` whose `source` is a non-`user` kind (plugin or goal). `PromptMessageData` gained the optional `meta` that `context/message` carried. The surface, derivation, and `SurfaceEventType` drop `context/message`; consumers that need "is this a human prompt?" read `source.kind === 'user'` instead of the event type. This keeps goal-authority's human-authority check exactly as strict as before — an injected message defaults to a plugin source and can never satisfy `source.kind === 'user'`.

**Goal replay disambiguates by round, not type.** A goal state change is a round-zero goal-sourced `user/message` carrying `goal/change` metadata; a positive round is an admitted continuation prompt. `decodeGoalEvent` now takes a `user/message` and still fails loud on goal metadata under a non-goal source or a goal source lacking metadata.

**Delivery returns an id.** Each delivery method returns an opaque branded `AgentMessageId` for the accepted input. FIFO methods carry it through their inbox lifecycle events; injection bypasses those events.

**Three inbox events replace agent/queued.** `agent/inbox/enqueue` (an item entered a FIFO), `agent/inbox/dequeue` (the driver claimed one), and `agent/inbox/discard` (`cancel()` dropped pending items) each carry an `AgentMessage` — the accepted message including its returned `id`, steering/wakeup facts, source, and contexts — so a caller can correlate a queued item with its lifecycle. Injection never touches a FIFO and emits none of these. Every FIFO entry publishes an enqueue, including the loop-authored continuation-reason steer (`agent/turn-continuation` returning `{ action: 'continue', reason }`), so the ledger stays balanced with its later dequeue or discard. The `dsh-agent` invariant companion asserts FIFO conservation: a per-agent outstanding count that dequeue and discard can never drive negative.

**cancel gains keepInbox.** `cancel(cause?, { keepInbox? })`; when true it aborts the active turn but preserves queued and steering items (no discard event, and un-started work is not dropped).

## Alternatives considered

- **A dedicated `MessageSource` kind `context`** for injected content. Rejected because `plugin` already means "not a human," so a fourth kind would add a parallel axis the authority checks would have to learn. Injected context defaults to a plugin source instead.
- **A typed discriminant field on `PromptMessageData`** (e.g. `origin: 'prompt' | 'context'`) to replace the event-type split. Rejected in favor of `source`, which every consumer already carries and which the goal system already keyed on; a second discriminant would duplicate that fact.
- **Keeping `agent/queued` alongside the inbox events.** Rejected as a mirror: `agent/inbox/enqueue` is the same enqueue-time signal with the accepted routing facts, and the dequeue/discard events complete the FIFO lifecycle the single event could not describe.

## Consequences

The concrete driver has one delivery mechanism. Four common helpers hide its (`target` × `wakeup`) matrix behind caller intent, while `send` exposes the fully resolved matrix for advanced callers. One durable message type serves prompts, injected context, and goal rounds, so the surface projection and every “human prompt?” check simplify to a `source` test. The goal fold's channel split moves from event type to `source.round`, and every consumer that filtered `context/message` filters `user/message` by source. The turn-enclosure and reconstruction invariants are unchanged: an idle injection still wraps a one-shot turn, now emitting `user/message` instead of `context/message`.

Internally, `wakeup` is the “should the model run” signal, so the inbox distinguishes `hasWakingQueued` (drives the loop and idle/quiescence decisions) from `hasQueued` (anything to dequeue): a lone `queue()` item stays parked at idle and rides along the next waking follow-up, and `whenIdle`/`cancel` settle quiescence off the waking signal (a lone quiet item takes `whenIdle`'s fast path, so no waiter is left hanging). `SendOptions.meta` on a queued or steering message is carried onto the durable `user/message`/`steering/message`, matching injection; it is intentionally absent from the live `AgentMessage`, which carries only routing facts. Every enqueued id gets exactly one terminal lifecycle event: a terminal stop that drops pending steering emits `agent/inbox/discard` both at the in-turn stop point and on the post-turn drain of late steering, and disposal discards any still-pending items before the loop exits. The `agent/inbox/*` payload is frozen so a listener cannot mutate the shared correlation object mid-dispatch, and a loop-authored continuation reason is snapshotted and frozen like public steering. Injection validates its payload before opening an idle one-shot turn; `InjectOptions` omits attached contexts, while the non-waking next-step variant of `ResolvedAgentInput` requires an empty context tuple.

## Related

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md) — the one-claimed-message-per-turn rule this builds on.
- [remove-agent-steering-mirror](../simplification/2026-07-04-remove-agent-steering-mirror.md) — the precedent for collapsing a mirrored live event.
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md) — the cancel-cause signal `keepInbox` extends.
- [intent-named-agent-delivery](2026-07-24-intent-named-agent-delivery.md) — the public helpers and fully resolved acceptance interface.
