# Agent Note: TUI status line badges queued steering messages

Status: implemented
Archived: 2026-07-26

English | [中文](2026-07-21-tui-steering-queue-badge.zh.md)

## Problem

While a turn runs, an editor submission calls `agent.steer()` and joins the steering queue behind the running turn ([front-door Agent Note](2026-07-17-dedicated-full-screen-tui-front-door.md)). The running status line ended only with the `Enter sends steering, Esc cancels` hint, so pressing Enter gave no feedback that the message landed or how many were waiting to reach the model. A user steering several times could not tell the queue from a dropped keystroke.

## Decision

The agent's inbox is the authoritative steering queue but is not observable from the TUI, so the badge is a live count reconstructed from successful TUI steering submissions and `steering/message` events rather than a projection of the queue itself.

- The running status line composes through `formatTurnStatus`, which inserts a `${queued} queued · ` badge before the `Enter sends steering, Esc cancels` hint when `queued > 0` and shows the plain hint at zero; the phase label and elapsed timing before it are the [verbose status line](2026-07-21-tui-verbose-status-line.md)'s.
- `createTuiChat` records each successful running-state `agent.steer()` submission, removes its matching source on each `steering/message` session event as the loop drains one, and resets the list whenever the agent leaves `running`.
- The count refreshes onto the live `Loader` through `setMessage`; the refresh is a no-op while idle because the loader exists only during a running turn.
- The reset lives in the `agent/status` transition, not in `setStatus`, because `setStatus` also runs on mid-turn palette changes and must not clear a live count.

## Alternatives considered

**Derive the count from the session log alone** (enqueued minus drained, recomputed on replay). Rejected: a cancellation clears the inbox without logging a drain, so the log cannot distinguish a drained message from a discarded one; the reset-on-non-running anchor is simpler and self-correcting each turn.

**Reset inside `setStatus`.** Rejected: `setStatus` re-runs on `applyColorScheme` mid-turn, which would wrongly zero a live count; the status transition is the only place a turn actually ends.

**Count every public inbox enqueue.** Rejected: `AgentMessage` intentionally omits driver routing state, so an observer cannot distinguish queued turns from steering. The TUI instead owns the submissions represented by its badge.

**Make the wording or a threshold configurable.** Rejected: the no-hardcoded-tunables rule targets deployment-varying behavior, not brand copy; the `welcome`/hint strings are already fixed presentation.

## Consequences

- The badge is best-effort live UI state, not a logged surface: it is rebuilt from events and reset each turn, never persisted, so a resumed running turn starts its badge from zero.
- A cancellation mid-queue clears the badge cleanly through the non-running reset, and a drain past zero is a no-op — neither can strand a stale count.
- Steering submitted outside this TUI is absent from the badge; the count describes feedback for this editor's submissions rather than the agent's complete inbox.
- `packages/ui/tui/src/index.ts` stays at 100 % per-file coverage.

## Testing

`packages/ui/tui/tests/tui.spec.ts` drives the running status frame through the real `createTuiChat`: the plain hint at zero, the increment to `2 queued` after editor submissions, the decrement as each message drains, an unrelated drain ignored, and the reset when the turn ends.
