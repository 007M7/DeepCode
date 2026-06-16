# ADR 0017: Every session event is enclosed in a turn

Status: accepted (2026-06-15)

## Context

A durable session-persistence backend (added in a companion change) uses the **turn** as its crash-recovery boundary: a crash can leave an unclosed final turn, which `load` closes with a synthetic `turn/end {kind:'interrupted'}` while preserving the turn's real events (see [ADR 0018](0018-session-persistence.md)). This recovery is only well-defined if nothing *legitimately* durable sits OUTSIDE a turn — between the last `turn/end` and the next `turn/start` — since such an event would be swept into the next turn's interrupted close.

That assumption did not hold. Two paths recorded events outside any turn:

1. **Queued user messages.** The loop drained queued messages and appended `user/message` *before* `turn/start` — so a turn's own prompt sat in the gap between the previous `turn/end` and the next `turn/start`.
2. **Idle context injection.** `agent.inject()` appends a `context/message` directly. Its real production caller is `dsh-tool-bash`, which injects a background-task completion notice from `ctx.bash.onTaskDone` — a callback that fires whenever a background bash task finishes, frequently while the agent is **idle** (between turns).

In case 2, if the injected `context/message` is the last event before a flush/dispose (no later turn appends a `turn/end`), `scanLog` treats it as crash debris and **drops it on resume** — the injected context is durably on disk but silently lost on reload. Case 1 was benign in isolation (a `user/message` is always followed by the turn it triggered) but made the "what may appear outside a turn" rule fuzzy.

Two ways to fix it: relax the *reader* (let `scanLog` commit events that sit outside an open turn), or constrain the *producer* (make every event turn-enclosed so the reader's simple "last `turn/end`" rule is both correct and complete). We chose the producer-side invariant: a single, checkable rule beats a more permissive boundary scan that has to reason about partial turns *and* loose between-turn events.

## Decision

**Every session event lives inside a turn** — between a `turn/start` and its matching `turn/end`. Concretely:

- The loop appends queued `user/message` events **after** `turn/start` (inside the turn), not before it. `turn/end` is therefore owed the moment those messages are recorded, and the existing finalizer guarantees it.
- An `agent.inject()` made while the agent is **running** appends its `context/message` into the already-open turn (unchanged).
- An `agent.inject()` made while **idle** wraps its `context/message` in a one-shot turn: `turn/start{trigger:{kind:'injection'}}` → `context/message` → `turn/end{completed}`. A new `injection` variant joins the merge-extensible `TurnTriggerMap`.
- The loop derives the next turn number from the log each iteration (`lastTurnNumber(session) + 1`) instead of keeping a private counter, so an idle injection's one-shot turn cannot collide with the next real turn's number.
- The `dsh-invariants` plugin **enforces** the invariant in dev: a `user/message` / `context/message` / `steering/message` appended while no turn is open throws an `InvariantError`.

The serializability invariant is enforced at the same source boundary (`Session.append` throws on non-JSON-serializable data), so "what may enter the log" is now governed in one place rather than discovered downstream by whichever backend happens to be watching.

## Consequences

The turn is now the *single* durability/replay boundary, so [ADR 0018](0018-session-persistence.md)'s crash-recovery rule is complete, not merely sufficient: an interrupted final turn is closed (with a synthetic `turn/end {interrupted}`) and its real events preserved, with zero risk of conflating between-turn context into it, because there is no between-turn context. `scanLog` stays simple (one possibly-open final turn, never a loose between-turn event), and an idle background-task notice survives persist + resume.

Costs: `agent.inject()` while idle now writes three log lines instead of one, and the derived history gains a turn that carries only injected context (no assistant output) — `deriveMessages()` already derives purely by event type, so this renders identically. The `injection` trigger is a new on-disk vocabulary value; like every `SessionEventMap`/`TurnTriggerMap` addition it is part of the frozen format. Event ordering within a turn changed (`turn/start` now precedes `user/message`), which is observable to anything that asserted the old order — the loop's own tests were the only such consumers.

The rule is intentionally producer-enforced and dev-checked rather than reader-tolerated: a future backend (SQLite/WAL) inherits the same clean boundary for free, and a plugin that records an event outside a turn fails loudly in dev instead of silently losing data on the next reload.

The invariant also constrains where the loop may record an `error` event. A failure detected while a turn is open is appended INSIDE the turn (before `turn/end`); but a failure that surfaces once the turn is already closed — a rejecting `session/flush` (which runs as the post-`turn/end` durability checkpoint) or a throwing `agent/turn-end` listener (after `closeTurn` already appended `turn/end`) — has no in-turn position left. Appending an `error` there would land it past the last `turn/end`, exactly the crash-tail position a backend discards. So those post-turn failures are reported via the `agent/error` event and the logger only, never as a `SessionEvent`; the turn stays balanced and persistence keeps its buffered events for the next checkpoint. If durable operational diagnostics are ever needed, they belong on a separate telemetry channel, not the replayable session log.
