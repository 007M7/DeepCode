# Agent Note: Foldable injected-context cards in the TUI

Status: implemented

English | [中文](2026-07-28-tui-foldable-context-cards.zh.md)

## Problem

The TUI rendered every injected-context message (a non-`user` `user/message` source: `workspace-context`, `goal`, and other plugins) as three loose transcript children — a dim `Context · <label>` header, the message's XML root element name (`system-reminder`), and the body — always fully expanded. Two things read badly. First, unlike tool-call cards, a context card could not be collapsed, so a large `workspace-context` reminder occupied the transcript permanently with no `Ctrl+O` fold. Second, the XML root element rendered as its own literal line (`system-reminder`) directly under the `Context · workspace-context` header that already names the source, so the frame element read as raw-XML noise duplicating the header.

## Decision

Injected context renders as a `ContextCardComponent` (`packages/ui/tui/src/components/transcript.ts`), a collapsible dim card that shares the tool-card `Ctrl+O` toggle and starts collapsed. Its header is the same dim `Context · <label>` line. Its body is the message text as muted prose rows with the redundant frame lines stripped: the source label already names the context, so the body starts at the instruction content and the `system-reminder` line is gone. The body folds to the card's `maxToolOutputLines` budget through the shared `preview` helper, showing the `… +N lines (Ctrl+O to expand)` marker. Neither the fold nor the frame stripping depends on the payload's syntax ([content-independent fold](../bug-fix/2026-07-28-context-card-content-independent-fold.md), [prose rendering](../bug-fix/2026-07-28-context-cards-render-prose-not-xml.md)); this note's original implementation routed both through `renderUnknownXml`.

`Ctrl+O` cycles the shared `toggleTools` handler through three states — collapsed preview, expanded, hidden — matching Codex's behavior: the hidden phase removes tool cards (and their leading gap, which the card renders itself) from the transcript entirely. Context cards carry injected instructions rather than tool traffic, so they never hide; the hidden phase reads as their collapsed preview. The notice names the state (`Tool and context cards {collapsed|expanded}.` / `Tool cards hidden.`) and the `/help` shortcut line reads `Ctrl+O cycle cards (collapse/expand/hide)`. `renderEvent` tracks each card in a `contextCards` set alongside `allToolCards`, cleared by `rebuildTranscript`.

The label derivation tolerates a non-object source shape (an invalid injected source that is neither a session-reference card nor an object): it falls back to the generic `context` heading rather than dereferencing `plugin`/`kind` off a non-object. The `sessionReferenceCard` branch (the single-line referenced-sessions row) is unchanged — it has nothing to fold.

The change is TUI-only. It touches `ContextCardComponent`/`ToolCardComponent` wiring in `transcript.ts` and the `renderEvent`/`toggleTools`/help paths in `packages/ui/tui/src/index.ts`. No producer, session event, or other UI bridge (ACP, JSON-RPC) changes; the fold shape is TUI-local and not a cross-package contract.

## Alternatives considered

**Keep context cards fully expanded, only drop the root line.** Rejected: the primary complaint was that a large `workspace-context` reminder cannot be folded like a tool card. Dropping the redundant frame line alone leaves the transcript-occupancy problem unsolved.

**A dedicated shortcut for context cards, independent of tool cards.** Rejected in favor of sharing `Ctrl+O`: one key matches the existing mental model and adds nothing to learn or document, and the two card kinds fold for the same reason (transcript noise). The cycle's hidden phase applies only to tool cards for the same reason a shared key works: hiding injected instructions would remove content the user cannot recover from any other card.

**Suppress the root line generically inside `renderUnknownXml`.** Rejected: `renderUnknownXml` also renders unknown tool results, where the root element is meaningful. Root suppression is a context-card presentation choice and lives in `ContextCardComponent`, keeping the tool-card path unchanged.

## Consequences

A `workspace-context` reminder now collapses with the same `Ctrl+O` that folds tool cards, and its body no longer prints the redundant `system-reminder` frame line under the header. The cost is a second card kind tracked for the shared cycle and a small label-shape fallback for invalid injected sources. Because the change is confined to the TUI transcript, ACP and JSON-RPC bridges keep their own injected-context presentation.

## Testing

`packages/ui/tui/tests/tui.spec.ts` pins that a context card is collapsed by default with the `Ctrl+O to expand` marker, expands on `Ctrl+O` with the `Tool and context cards expanded.` notice, survives the hidden phase at its collapsed preview while tool cards disappear from a repaint, returns to `collapsed` on the fourth press, drops the `system-reminder` frame line, renders unframed context as muted prose, and renders an empty frame header-only. The keyless terminal snapshots under `packages/ui/tui/tests/snapshots/` — rendered through the real assembled TUI and a pseudo-terminal — were re-recorded and show the frame-less context card, the updated toggle notice, and the updated `/help` shortcut line.
