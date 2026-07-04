# RFC: Remove the `agent/steering` mirror emit

Status: proposed

## Problem

`agent/steering` is the last remaining transient mirror of a durable session event. The loop's steering drain appends the durable `steering/message { turn, content, source }` and, on the very next line, emits `agent/steering(agent, turn, content, source)` — the identical fact as a fire-and-forget event (`packages/core/agent-loop/src/loop.ts`, `drainSteering`). It has zero production listeners: the only subscriber anywhere is a loop regression test asserting the emit carries `source` — the same fact the durable event already records one line above.

Both mirror-removal RFCs retained it while explicitly deferring the decision this RFC now makes. The [boundary-mirror removal](../../implemented/simplification/2026-06-20-remove-agent-boundary-mirror-events.md) kept it as "a live control signal, not a boundary"; the [stream-chunk removal](../../implemented/simplification/2026-07-02-remove-stream-chunk-mirror.md) kept it as "a live control signal with no durable twin, retained (its fate is a separate future decision)". The second rationale does not survive the code: the durable twin is `steering/message`, appended immediately before the emit with the same payload. The mirrored-vs-live-only line the taxonomy actually draws puts it on the mirror side: `agent/queued` is genuinely live-only (it fires at enqueue time, before any durable event exists, and already carries a `steering: boolean` flag — cancelled queued work never enters the log), while `agent/steering` fires at the exact moment its durable twin lands, carrying nothing the log does not.

Steering carries real production traffic — the hook bridges' turn-continuation decisions inject their reasons through `inbox.steer()`, landing as durable `steering/message` events that the hook-matrix goldens pin — and every one of those consumers observes the durable event. Nothing observes the mirror.

## Proposal

Remove the `agent/steering` declaration from `packages/core/agent/src/types.ts` (and its mention in the live-events JSDoc list there), the emit in `drainSteering` (whose `ctx` parameter becomes unused and goes too), the row in `packages/core/agent/README.md`, and the emit line in the loop-pseudocode blocks (`packages/core/agent-loop/src/loop.ts` module doc and [architecture.md](../../../architecture.md)); run `pnpm run gen-cordis-catalog`. Retarget the one regression test at the durable `steering/message` event — the source-preservation fact it pins lives on the log. The implementing PR amends the two retaining RFCs' scope lines per [implemented/AGENTS.md](../../implemented/AGENTS.md): the boundary RFC's retained-list entry and the stream-chunk RFC's "no durable twin" clause.

## Why not keep it?

"It is a control signal, not a boundary" — but the taxonomy's operative distinction is mirrored-vs-live-only, not control-vs-boundary, and this event mirrors. A consumer that wants enqueue-time notification has `agent/queued` (with its steering flag); a consumer that wants drain-time notification is by definition asking for the moment `steering/message` is appended, which `session/event` delivers with the same payload plus durability. The rejected [retire-mid-turn-steering RFC](../../rejected/simplification/2026-06-20-retire-mid-turn-steering.md) defended the steering *capability* — `steer()`, the durable event, continuation forcing — all of which this removal keeps untouched.

## Acceptance criteria

- No `agent/steering` spelling outside this RFC and the two amended RFCs; the catalog is regenerated and fresh.
- The retargeted test pins source preservation on `steering/message`; the suite is green.

## Risks

None known: zero production listeners exist to migrate, and both live-notification needs (enqueue, drain) have surviving homes (`agent/queued`, `session/event`).
