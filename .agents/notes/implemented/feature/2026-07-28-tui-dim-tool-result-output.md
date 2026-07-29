# Agent Note: Dim tool-result output inside TUI tool cards

Status: implemented

English | [中文](2026-07-28-tui-dim-tool-result-output.zh.md)

## Problem

After the [fixed `Tool / <name>` header](2026-07-27-tui-tool-card-header.md) moved every tool-specific detail into the card body, that body became a flat block at the terminal's default foreground: a presenter title, a terminal `$` command, its cwd, and the tool's own output all read as one undifferentiated run of text. A transcript of several calls gave no visual cue for where the card's framing ended and what the tool actually produced began, and long command output competed with the surrounding conversation for attention even though it is reference material a reader skims rather than reads.

## Decision

The framing/output split below is superseded by [one dim tone for the whole card body](2026-07-28-tui-uniform-dim-card-body.md), which keeps dim output but extends it over the framing rows; that note owns the current rule and the reason the split read as scatter. What remains current here is why tool output is recessed at all, and the diff-card and blank-row carve-outs both notes share.

Inside a tool card, the tool's own output renders in the `dim` palette role while the card's framing keeps its existing color. Framing is the presenter title, a terminal card's `$` command line and cwd row, and a diff card's per-file path headers and `+`/`-` lines; output is a terminal card's captured stdout/stderr and a generic card's result text.

`ToolCardComponent.renderBody` in `packages/ui/tui/src/components/transcript.ts` returns a `CardBody` of `{ prelude, lines }` instead of one flat string array. `prelude` holds already-styled framing rows that render verbatim; `lines` holds the tool's text. A terminal card dims its output rows through `dimOutput`, which leaves a blank row as the empty string so the branch's existing blank-row filter still drops it rather than keeping an ANSI-wrapped empty value. A diff card returns its hunks and change footer entirely as `prelude`: the `+`/`-` colors already carry the diff's meaning, and dimming them would fight that signal.

A generic card renders its title and result as one Markdown document and dims only the rows past the title's, in `dimPastPrelude`. Rendering the title alone at the same width yields its row count, so the split survives wrapping and the document keeps its own block spacing — notably the blank row pi-tui's Markdown places between a leading paragraph and a following heading, which a two-document split would drop. A whitespace-only row is left unwrapped so Markdown's line padding stays out of the styled ranges. Markdown role colors (headings, inline code) still apply over the dim base, so a dim result keeps its internal structure.

Exit and signal markers keep their existing roles (`dim [exit N]`, `error [signal …]`), and the collapsed-preview marker stays dim, so the change adds no new palette role and no configuration.

## Alternatives considered

**Dim the whole card body.** Rejected: it flattens a diff card's `+`/`-` green and red, which is the one place color carries meaning rather than emphasis, and it dims the `$` command a reader scans for to identify what ran.

**Change the generic card's Markdown base color and keep the title inside the same document.** Rejected: `DefaultTextStyle.color` applies uniformly to every row, so the title would dim along with the result. Splitting the title into its own document instead loses the blank row Markdown inserts before a heading, which visibly closed the gap between title and result in the `run_code` and `cordis_inspect` cards.

**Introduce a dedicated `toolOutput` palette role.** Rejected: no consumer needs it distinct from `dim`, and the palette's role set is the contract other components read; adding a role that resolves to the same SGR pair buys nothing.

**Dim every row unconditionally in `dimOutput`.** Rejected: wrapping an empty string yields a non-empty ANSI value, which defeats the terminal branch's `filter(Boolean)` and adds a blank row to every card whose output ends in a newline — that is, nearly every real bash result.

## Consequences

A card now reads as framing plus output at a glance, and a transcript of many calls scans as a column of headers with recessed detail beneath each. The cost is that `dimPastPrelude` renders a generic card's Markdown twice per frame — once for the prelude alone to count its rows, once for the whole document — which is acceptable at card scale and keeps the row split correct under wrapping. Because dim is an SGR attribute rather than a color, a result's Markdown role colors survive underneath it, so a dim body is still structured rather than uniformly gray. The treatment is TUI-local: ACP and JSON-RPC bridges keep their own tool-call presentation, and no presenter or `presentation.ts` type changed.

## Testing

`packages/ui/tui/tests/tui.spec.ts` pins the blank-row guard with color enabled, where the dim wrapper is what makes an empty row non-empty; the assertion fails if `dimOutput` wraps unconditionally. The keyless terminal snapshots under `packages/ui/tui/tests/snapshots/` and `examples/tui-agent/tests/snapshots/` were re-recorded and carry the new `dim` style ranges for bash output, read output, `run_code`, `workflow`, `subagent`, `todo_write`, and `cordis_*` results, while the diff cards' `+`/`-` ranges and the `$` command rows are unchanged.
