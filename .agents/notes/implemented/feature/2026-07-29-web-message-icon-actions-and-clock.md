# Agent Note: Web message IconActions and clocks

Status: implemented

English | [中文](2026-07-29-web-message-icon-actions-and-clock.zh.md)

## Problem

The web chat user bubble already had copy / branch / edit IconActions but no clock. Finalized assistant narration had no under-body action chrome at all, even though the Harness design shows a copy / branch / clock row after the answer settles. Streaming replies must not flash that chrome mid-token. Memoized rows also keep stable props across midnight, so a one-shot `Date.now()` would leave yesterday's messages stuck on `HH:mm`.

## Decision

**User bubbles prepend a date-aware local clock to the existing IconActions row; finalized assistant nodes append a copy / branch / clock row with `margin-top: 16px`; both seats re-format at the next local midnight.**

Both seats format `node.time` through `formatMessageClock`: same calendar day → `HH:mm`, earlier this year → `M月D日 HH:mm`, other years → `YYYY年M月D日 HH:mm`. `useCalendarDay` is a component-local day tick (timeout to the next local midnight) so memoized rows re-render when the calendar day changes without a new framework hook. `MessageItem` places the label before copy (figma `388:20051`). `AssistantMarkdown` places it after branch (figma `43:32997`) and only when `streaming` is false with a known event time; the streaming tail omits the row. Copy writes joined text blocks. Branch stays a chrome stub. Hover-capable pointers keep both footers opacity-hidden until hover/focus-within. Clipboard write and the clock helpers live in `message-chrome.ts`. The assembled surface is pinned by `apps/web/tests/message-actions.e2e.ts` (cold-seeded history + aria golden); aria normalization collapses every clock shape to `{{clock}}`.

## Alternatives considered

**Show assistant IconActions during streaming.** Rejected: the request is to reveal the row only after output completes; mid-stream chrome would flicker and invite copying a partial answer.

**Wire branch to a real session fork.** Rejected for this change: same rationale as the archived [user IconActions note](../../archived/feature/2026-07-27-user-message-icon-actions.md) — the mutation path is unspecified; the button reserves the design seat.

**Publish the calendar day through a chat store or inject hook.** Rejected: the day tick is presentation-only local state with no cross-entry consumers; a component-local timeout matches the client rule that behavioral hooks may own state that does not subscribe to an external source.

## Consequences

Settled assistant answers expose copy and the event clock immediately; branch stays a stub. User and assistant clocks share the same day/year widening rules and refresh after midnight without a message mutation. Per-message paging remains a deferred footer seat in the package README. Package tests pin the three clock shapes and the midnight widen; the web e2e scenario pins the assembled IconActions chrome.
