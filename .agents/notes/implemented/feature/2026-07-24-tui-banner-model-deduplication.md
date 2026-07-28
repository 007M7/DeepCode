# Agent Note: The startup banner omits the model

Status: implemented

English | [中文](2026-07-24-tui-banner-model-deduplication.zh.md)

## Problem

The startup banner repeated the selected model directly above the prompt context, which already keeps the model visible while the TUI is idle. The duplicate added no information and made the banner detail line harder to scan.

## Decision

- The borderless startup banner shows the product title, optional `welcome` or session-title subtitle, and session id.
- The banner omits the model name. The prompt context remains the persistent model display and updates after `/model` selection.
- The sweep animation and configured-welcome behavior are unchanged.

This supersedes only the model-in-banner portion of the [borderless banner decision](../../archived/feature/2026-07-21-tui-borderless-banner.md).

## Alternatives considered

**Remove the entire detail line.** Rejected: the session id remains useful for identifying and resuming the active session, and it is not duplicated in the prompt context.

**Remove the model from the prompt context instead.** Rejected: the prompt context stays visible after the startup banner scrolls away and reflects later model selections.

## Consequences

- Startup uses the banner detail row only for the session id.
- The model appears once in the initial idle view, in the prompt context.
- Banner snapshots and runnable TUI replay snapshots contain a shorter detail row.

## Testing

`packages/ui/tui/tests/tui.spec.ts` asserts that completed banners retain the session id without the former `<model>  •  <session-id>` text. Package-local and runnable-example TUI snapshots pin the resulting rows.
