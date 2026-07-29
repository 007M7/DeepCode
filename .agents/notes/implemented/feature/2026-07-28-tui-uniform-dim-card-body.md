# Agent Note: One dim tone for the whole TUI tool-card body

Status: implemented

English | [中文](2026-07-28-tui-uniform-dim-card-body.zh.md)

## Problem

[Dimming tool-result output](2026-07-28-tui-dim-tool-result-output.md) split a tool card into framing that keeps its own color and output that renders dim. In a real transcript that split read as scatter rather than structure, because the framing rows are not one color: a generic card's presenter title (`Read src/foo.ts (95 - 149)`, `Update todo list`) stayed at the terminal's default foreground, a terminal card's `$` command was cyan, its cwd was dim, and the output below was dim. Three tones in four consecutive rows, and the brightest one — plain default foreground, which reads as solid black on a light scheme — sat on the least informative row.

An unknown tool's XML tree was worse, and is what surfaced the problem. `renderUnknownXml` styled element names through its `label` callback but emitted text content with no styling at all, while the card's collapsed `… +N lines (Ctrl+O to expand)` marker was dim. The card body therefore mixed unstyled black content rows with a dim fold hint, so the hint looked like it belonged to a different element than the text it summarized. The same undifferentiated-body complaint the earlier note set out to fix had reappeared one level down, inside the body.

The underlying reason is that the two roles are indistinguishable on one of the two supported schemes. `dim` is SGR 2 on a dark scheme but ANSI 90 on a light one, exactly what `muted` always is, so a body that mixes `dim`, `muted`, and unstyled rows collapses to two tones on light terminals and three on dark — a difference that reads as inconsistency rather than as meaning.

## Decision

A tool card's body is one dim tone end to end. The card's only colored row is its `Tool / <name>` header, which carries call status (warning pending, success ok, error). The presenter title, a terminal card's `$` command line and its cwd, the tool's own output, an XML tree's text content, and the collapsed fold marker all render through the `dim` role.

Two exceptions keep color where color is the meaning rather than emphasis: a diff card's `+`/`-` lines and per-file path headers, whose red and green *are* the diff, and a terminal card's `[signal …]` marker, which reports abnormal termination. An XML tree's element names stay `muted`, one shade off body text, because they are structure a reader navigates by rather than content.

`renderUnknownXml` takes a `body` styler beside its existing `label` styler and applies it to every text row — `textBlock`'s lines and the single-line `<tag>: value` form's value. Its one caller, the unknown-tool card, passes the card's body tone (`dim`), so tree content matches the rows around it instead of falling back to the default foreground.

`ContextCardComponent` renders [injected context as prose](../bug-fix/2026-07-28-context-cards-render-prose-not-xml.md) rather than parsing it, and its body moves from `muted` to `dim` for the same reason the tool cards changed: the card's header and fold marker are already `dim`, so a `muted` body was the one row group that did not match.

`ToolCardComponent.dimPastPrelude` becomes `dimBody`: it still renders prelude and result as one Markdown document so the document's own block spacing survives, but dims every row rather than only those past the prelude's row count. That deletes the second Markdown render the old row-counting split needed, since there is no longer a boundary to locate. A whitespace-only row stays unwrapped, keeping Markdown's padding out of the styled ranges, and the terminal branch's blank rows stay the empty string so its `filter(Boolean)` still drops them.

## Alternatives considered

**Keep the framing/output split and just fix the XML tree.** Rejected: it addresses the reported symptom and leaves the cause. The split's premise is that framing shares one color, which was never true — the presenter title, the cyan `$` command, and the dim cwd are three tones — so every future framing row reopens the same question.

**Give the presenter title its own role (bold, or accent).** Rejected: it adds a fourth tone to the row the user identified as noise. The header already names the tool, so the title is a detail line, not a heading; emphasizing it competes with the status color directly above it.

**Keep the `$` command cyan as a scan anchor.** Considered and explicitly declined by the user in favor of a uniform body. The `$ ` prefix and the header's `/ <description>` segment already locate the command, so the color was redundant with two other cues.

**Make `dim` and `muted` visually distinct on light schemes so the existing three-tone body reads as structure.** Rejected: the palette is built from the 16-color ANSI set precisely so terminals remap it, and the only tones reliably dimmer than default foreground on both schemes are the two that already collapse. Manufacturing a third would mean fixed shades, which the palette contract forbids.

**Dim diff `+`/`-` lines too, for a fully monochrome transcript.** Rejected: a diff's colors carry its semantics, and the leading `+`/`-` character alone is a weaker signal that a reader must parse rather than see.

## Consequences

A card now reads as one colored header over a recessed block, and a transcript of many calls scans as a column of status headers. The user-visible change is that presenter titles, `$` commands, and XML tree content lost their distinct tones; the reported scatter goes with them.

`dimBody` renders a generic card's Markdown once per frame instead of twice, so the earlier note's stated cost is gone. Because `dim` is an SGR attribute on dark schemes rather than a color, a result's Markdown role colors (headings, inline code) still show through underneath it, so a dim body keeps its internal structure on dark terminals; on light schemes `dim` resolves to ANSI 90 and those roles read against gray instead.

The `renderUnknownXml` signature gained a required parameter, so its caller and its unit test pass a body styler; there is no default, because a caller that forgets one is exactly the bug this note fixes. The treatment stays TUI-local: no presenter, palette role, or `presentation.ts` type changed, and the ACP and JSON-RPC bridges keep their own tool-call presentation.

## Testing

`packages/ui/tui/tests/xml-tool-output.spec.ts` asserts the body tone through a distinct `[body]…[/body]` marker on every text row, so a regression that drops the styler fails rather than silently rendering unstyled text. It also pins that an interior blank line stays the empty string, since styling it would emit an escape-only row that reads as a stray indented blank.

The keyless terminal snapshots under `packages/ui/tui/tests/snapshots/` and `examples/tui-agent/tests/snapshots/` were refreshed from committed replay scripts. Their diffs are style ranges only: `fg=cyan` and `fg=bright-black` rows become `dim`, and rows that previously carried no style gain it — covering bash output, read output, `run_code`, `workflow`, `subagent`, `todo_write`, `cordis_*`, and injected-context prose, while the diff cards' `+`/`-` ranges are unchanged.
