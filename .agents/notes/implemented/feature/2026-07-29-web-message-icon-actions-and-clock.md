# Agent Note: Web message IconActions and clocks

Status: implemented

English | [中文](2026-07-29-web-message-icon-actions-and-clock.zh.md)

## Problem

The web chat user bubble already had copy / branch / edit IconActions but no clock. Finalized assistant narration had no under-body action chrome at all, even though the Harness design shows a copy / branch / clock row after the answer settles. Streaming replies must not flash that chrome mid-token. Memoized rows also keep stable props across midnight, so a one-shot `Date.now()` would leave yesterday's messages stuck on `HH:mm`.

## Decision

**User bubbles prepend a date-aware local clock to the existing IconActions row; the last content-text assistant of each *settled* turn appends a copy / branch / clock row with `margin-top: 16px`; both seats stay visible whenever mounted and re-format at the next local midnight.**

Both seats format `node.time` through `formatMessageClock`: same calendar day → `HH:mm`, earlier this year → `M月D日 HH:mm`, other years → `YYYY年M月D日 HH:mm`. `useCalendarDay` is a component-local day tick (timeout to the next local midnight) so memoized rows re-render when the calendar day changes without a new framework hook. `MessageItem` places the label before copy (figma `388:20051`). `ChatView` derives turn-tail seqs via `assistantActionsSeqs` and withholds a still-running turn through `withholdActionsTurn` (streaming `partial.turn`, else the first `runningCalls` turn; a bare `running` bit before the first step does not strip a prior settled seat). Selectors return a primitive turn so chunk storms do not re-render the list parent. `AssistantMarkdown` places the row after branch (figma `43:32997`) only when `streaming` is false, the event time is known, and the node has non-empty text content. Think-only nodes, mid-turn narration, an active turn's content, and the streaming tail omit the row. Copy writes joined text blocks. Branch stays a chrome stub. Clipboard write and the clock helpers live in `message-chrome.ts`. The assembled surface is pinned by `apps/web/tests/message-actions.e2e.ts` (owned cold seed with mid-turn narration text + aria golden that places copy only under the user bubble and the turn-tail `DONE`); aria normalization collapses every clock shape to `{{clock}}`.

## Alternatives considered

**Show assistant IconActions during streaming.** Rejected: the request is to reveal the row only after output completes; mid-stream chrome would flicker and invite copying a partial answer.

**Put IconActions under every finalized assistant node (including Think-only).** Rejected: copy has nothing useful to write without text content, and repeating the chrome under every step/Think row clutters the flow; only content output owns the seat.

**Put IconActions under every content-text assistant in a multi-step turn.** Rejected: mid-turn narration (text before tools) is not the settled answer; repeating copy/branch/clock under each step clutters the flow. Only the last content assistant of a settled turn owns the seat.

**Derive the running-turn withhold from `running` plus the max turn among finalized nodes alone.** Rejected: after step-1 text lands and tools run for seconds that tip is temporarily "last content," so chrome would flash on then off; `partial` / `runningCalls` name the open turn without that flicker, and a bare `running` before the first step must leave the prior settled answer's seat alone.

**Hover-reveal the action row on hover-capable pointers.** Rejected: once the row exists it should stay discoverable; opacity hiding made the chrome easy to miss and required parent hover selectors that duplicated the mount gate.

**Wire branch to a real session fork.** Rejected for this change: same rationale as the archived [user IconActions note](../../archived/feature/2026-07-27-user-message-icon-actions.md) — the mutation path is unspecified; the button reserves the design seat.

**Publish the calendar day through a chat store or inject hook.** Rejected: the day tick is presentation-only local state with no cross-entry consumers; a component-local timeout matches the client rule that behavioral hooks may own state that does not subscribe to an external source.

## Consequences

Each settled turn's last content answer exposes copy and the event clock as soon as the row mounts; mid-turn content, an active turn's content, and Think-only nodes stay chrome-free; branch stays a stub. User and assistant clocks share the same day/year widening rules and refresh after midnight without a message mutation. Per-message paging remains a deferred footer seat in the package README. Package tests pin the three clock shapes, the midnight widen, the content-only gate, the turn-tail seq gate, and the running-turn withhold; the web e2e scenario pins the assembled IconActions chrome including mid-turn narration without a third copy control.
