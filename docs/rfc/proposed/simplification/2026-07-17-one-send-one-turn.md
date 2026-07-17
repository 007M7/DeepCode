# RFC: Give each ordinary send its own turn

Status: proposed

English | [中文](2026-07-17-one-send-one-turn.zh.md)

## Problem

`Agent.send()` snapshots one ordinary message and appends it to a FIFO, but the agent loop drains every waiting ordinary message into one turn. Whether adjacent sends share a turn depends on when the driver happens to dequeue: calls from one synchronous stack, neighboring microtasks, event listeners, and model callbacks can observe different grouping even though callers used the same API.

A shared turn also shares prompt admission, `turn/start`, `turn/end`, and the durability checkpoint. A later message can therefore join an earlier message's model request instead of observing the earlier turn's committed result. The batching branches for mixed allowed and blocked prompts add lifecycle states that no caller explicitly requests.

`steer()` already expresses joining the active turn, while `inject()` records model-facing context without acting as an ordinary message. Implicit batching makes `send()` overlap both explicit operations instead of preserving a single meaning.

## Proposal

The inbox will dequeue at most one ordinary message for each turn start. A successful `send()` will remain synchronous: it validates agent state, snapshots and freezes content, appends one FIFO item, and publishes `agent/queued`. If two items are both claimed, the second turn will start only after the first turn ends and its durability checkpoint completes; an item discarded before turn start will not create an empty turn.

Prompt admission will decide one message. An allowed prompt will become that turn's `user/message`; a blocked prompt will end that turn as `rejected`. The mixed-batch and all-blocked-batch branches will disappear.

Running `steer()` will continue to append to the active turn's steering FIFO. Idle `steer()` will continue to delegate to `send()` and therefore create an independent ordinary turn. `inject()` will retain its turn-enclosure and flush behavior. `cancel()`, `status`, and `whenIdle()` will remain whole-agent operations rather than per-message controls.

## Alternatives considered

**Keep opportunistic batching for throughput.** Combining queued prompts can reduce model calls when producers outpace the driver, but it makes turn boundaries depend on scheduling and prevents a later message from reliably observing the preceding turn's durable result. Explicit lifecycle semantics are worth the additional model calls; a future measured batching feature would need an explicit caller-visible contract.

## Acceptance criteria

- Two adjacent successful sends remain distinct FIFO items and, when both are claimed, produce two turns separated by the first turn's durability checkpoint.
- Dequeue timing and reentrant sends from queued listeners, session listeners, and model callbacks do not change the one-message turn boundary.
- Prompt veto, cancellation, disposal, and turn-start failure cannot merge messages or leave the agent permanently running.
- Running and idle `steer()`, `inject()`, whole-agent status, and `whenIdle()` retain their documented meanings.

## Risks

Workloads that intentionally relied on coincidental batching will make more model requests and may take longer to drain. FIFO queues may also grow under sustained producers. The proposal accepts those costs because the public `send()` boundary becomes deterministic; throughput optimization can return only with an explicit measured contract.
