# Agent Note: Web message IconActions and clocks

Status: implemented

English | [中文](2026-07-29-web-message-icon-actions-and-clock.zh.md)

## Problem

The web chat user bubble already had copy / branch / edit IconActions but no clock. Finalized assistant narration had no under-body action chrome at all, even though the Harness design shows a copy / branch / clock row after the answer settles. Streaming replies must not flash that chrome mid-token.

## Decision

**User bubbles prepend a date-aware local clock to the existing IconActions row; finalized assistant nodes append a copy / branch / clock row with `margin-top: 16px`.**

Both seats format `node.time` through `formatMessageClock`: same calendar day → `HH:mm`, earlier this year → `M月D日 HH:mm`, other years → `YYYY年M月D日 HH:mm`. `MessageItem` places the label before copy (figma `388:20051`). `AssistantMarkdown` places it after branch (figma `43:32997`) and only when `streaming` is false with a known event time; the streaming tail omits the row. Copy writes joined text blocks. Branch stays a chrome stub. Hover-capable pointers keep both footers opacity-hidden until hover/focus-within. Clipboard write and the clock helper live in `message-chrome.ts`.

## Alternatives considered

**Show assistant IconActions during streaming.** Rejected: the request is to reveal the row only after output completes; mid-stream chrome would flicker and invite copying a partial answer.

**Wire branch to a real session fork.** Rejected for this change: same rationale as the archived [user IconActions note](../../archived/feature/2026-07-27-user-message-icon-actions.md) — the mutation path is unspecified; the button reserves the design seat.

## Consequences

Settled assistant answers expose copy and the event clock immediately; branch stays a stub. User and assistant clocks share the same day/year widening rules. Per-message paging remains a deferred footer seat in the package README. Tests pin the three clock shapes, assistant footer presence only when not streaming, and copy payload (text blocks only).
