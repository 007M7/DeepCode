# Agent Note: TUI message header timing

Status: implemented

English | [中文](2026-07-24-tui-message-header-timing.zh.md)

## Problem

Turn timing beside the editor disappears from the transcript when the user scrolls and cannot appear until the editor status renders. A whole-turn aggregate also obscures the latency of later model requests after tool calls.

## Decision

Every model step creates an assistant header at `step/start`, before the first streamed chunk. The header displays `Model wait` immediately and refreshes at 100 ms resolution, then adds exclusive `Thinking`, `Response`, and `Tools` buckets as session events move the step between phases.

`step/end` freezes the header and adds the local completion timestamp. Transcript replay derives the same timing from durable event timestamps. Empty and tool-only steps retain a header, while failed live output and its header retract together when retry handling rebuilds the active session surface.

The prompt context retains only queued-steering state. Timing belongs to the model step that produced it rather than to the editor or the whole turn.

## Alternatives considered

Keeping timing beside the editor preserves a stable layout but hides per-step latency in scrollback and resume. Adding a second status line duplicates the same metric in two places. Labeling the first bucket `TTFT` is compact but requires protocol terminology; `Model wait` states the user-visible meaning without claiming that the first chunk is always text.

## Consequences

Users receive visible feedback before model output and can compare each request after tools or retries. Updating at 100 ms resolution causes more terminal renders while a model step is active. Internal timing state keeps the established `ttft` name because it identifies the measured bucket precisely; only rendered text uses `Model wait`.
