# Agent Note: Unify agent delivery on send(target × wakeup) and coalesce injected context into user/message

Status: implemented

English | [中文](2026-07-22-unified-send-and-coalesced-user-messages.zh.md)

## Problem

The agent's public driving surface had grown three near-parallel verbs — `send`, `steer`, `inject` — each with its own options type, its own live event story, and its own durable event. `send` and `steer` both queued a frozen inbox record and emitted `agent/queued`; `inject` bypassed the inbox and wrote a separate `context/message` durable event. The three verbs actually vary along only two independent axes: which queue an item joins (a whole new turn versus the active turn) and whether the item makes the model run. Encoding that 2×2 as three hand-written methods hid the symmetry, made "queue a turn without waking the driver" unreachable, and left `cancel()` with no way to abort a turn while preserving queued work.

Separately, `context/message` and `user/message` had converged: the surface projected both as verbatim user-role content, and the only real difference was that injected context carried `source`/`meta` and was "not a prompt." Two event types for one projection meant every consumer branched on event type to answer "is this a human prompt?", and the goal system used the type split as a side channel (round-zero state changes were `context/message`, admitted rounds were `user/message`).

## Decision

**One primitive, three preset aliases.** `Agent` is now an abstract class whose single abstract `send(content, { target, wakeup, source, contexts, meta })` covers the (`target` × `wakeup`) matrix. `followup` (`next-turn`/wakeup), `steer` (`next-step`/wakeup), and `inject` (`next-step`/no-wakeup) are concrete delegates on the base class, so concrete drivers implement `send` once and inherit the ergonomic presets. `wakeup` means "make the model run": wake a parked driver for a `next-turn` item, or force a continuation for a running `next-step` item. `send` defaults to `{ target: 'next-turn', wakeup: true }`, so every prior bare `agent.send(content)` call keeps its exact behavior. `next-turn`/no-wakeup (queue without waking) is now representable with no alias and no current caller.

**inject keeps its mechanism.** The `next-step`/no-wakeup path is exactly the old `inject`: durable model-facing context appended at the current log position (deferred behind an executing tool batch), or a one-shot `injection` turn when idle. It bypasses the FIFOs entirely and defaults its source to `{ kind: 'plugin', plugin: '' }`, never `{ kind: 'user' }`.

**context/message is gone.** Injected context is now a `user/message` whose `source` is a non-`user` kind (plugin or goal). `PromptMessageData` gained the optional `meta` that `context/message` carried. The surface, derivation, and `SurfaceEventType` drop `context/message`; consumers that need "is this a human prompt?" read `source.kind === 'user'` instead of the event type. This keeps goal-authority's human-authority check exactly as strict as before — an injected message defaults to a plugin source and can never satisfy `source.kind === 'user'`.

**Goal replay disambiguates by round, not type.** A goal state change is a round-zero goal-sourced `user/message` carrying `goal/change` metadata; a positive round is an admitted continuation prompt. `decodeGoalEvent` now takes a `user/message` and still fails loud on goal metadata under a non-goal source or a goal source lacking metadata.

**Three inbox events replace agent/queued.** `agent/inbox/enqueue` (an item entered a FIFO; carries `target`/`wakeup` on `InboxItemInfo`), `agent/inbox/dequeue` (the driver claimed one), and `agent/inbox/discard` (`cancel()` dropped pending items). Injection never touches a FIFO and emits none of these. Every FIFO entry publishes an enqueue, including the loop-authored continuation-reason steer (`agent/turn-continuation` returning `{ action: 'continue', reason }`), so the ledger stays balanced with its later dequeue or discard. The `dsh-agent` invariant companion asserts FIFO conservation: a per-agent outstanding count that dequeue and discard can never drive negative.

**cancel gains keepInbox.** `cancel(cause?, { keepInbox? })`; when true it aborts the active turn but preserves queued and steering items (no discard event, and un-started work is not dropped).

## Alternatives considered

- **A dedicated `MessageSource` kind `context`** for injected content. Rejected because `plugin` already means "not a human," so a fourth kind would add a parallel axis the authority checks would have to learn. Injected context defaults to a plugin source instead.
- **A typed discriminant field on `PromptMessageData`** (e.g. `origin: 'prompt' | 'context'`) to replace the event-type split. Rejected in favor of `source`, which every consumer already carries and which the goal system already keyed on; a second discriminant would duplicate that fact.
- **Keeping `agent/queued` alongside the inbox events.** Rejected as a mirror: `agent/inbox/enqueue` is the same enqueue-time signal with the added `target`/`wakeup` facts, and the dequeue/discard events complete the FIFO lifecycle the single event could not describe.

## Consequences

The delivery surface is now one primitive plus three self-documenting presets, and the (`target` × `wakeup`) matrix makes previously-unreachable combinations explicit. One durable message type serves prompts, injected context, and goal rounds, so the surface projection and every "human prompt?" check simplify to a `source` test. The cost: `Agent` became an abstract class, so object-literal test fakes must supply `followup` and cannot spread a class-typed value without re-casting (prototype methods are non-enumerable); the goal fold's channel split moved from event type to `source.round`; and every consumer that filtered `context/message` now filters `user/message` by source. The turn-enclosure and reconstruction invariants are unchanged — an idle injection still wraps a one-shot turn, now emitting `user/message` instead of `context/message`.

## Related

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md) — the one-claimed-message-per-turn rule this builds on.
- [remove-agent-steering-mirror](../simplification/2026-07-04-remove-agent-steering-mirror.md) — the precedent for collapsing a mirrored live event.
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md) — the cancel-cause signal `keepInbox` extends.
