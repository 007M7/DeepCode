# Agent Note: Context cards render injected context as prose, not as XML

Status: implemented

English | [中文](2026-07-28-context-cards-render-prose-not-xml.zh.md)

## Problem

`ContextCardComponent` rendered injected context through `renderUnknownXml`, the strict single-document XML tree renderer. That made two user-visible properties depend on whether the payload happened to be well-formed XML: the redundant frame row was dropped only via `xml.slice(1)` on a successful parse, and — before the [content-independent fold](2026-07-28-context-card-content-independent-fold.md) — so was folding.

Injected context is not XML. Three facts establish it:

- `<system-reminder>` is a prompting convention, not markup. No model is trained on the tag ([envelope rationale](../simplification/2026-07-20-unwrap-injected-content-envelopes.md)); it signals "injected, not the user speaking".
- Real instruction bodies contain characters that are fatal to a strict parse but ordinary in prose. A raw `&` in a badge URL's `&logo=` is an invalid entity reference; measured on a live session, one `workspace-instructions` payload carried four.
- The angle brackets inside those bodies are not elements. Every inner "tag" in this repository's own instructions is a placeholder in a path or command template — `packages/<group>/<pkg>/`, `-t <name>`, `Branded<B>`. Tree-rendering them as elements misrepresents the text.

The fragility was never workspace-specific: `dsh-tool-skill` builds the same frame and parses today only because no skill description has yet contained an `&`.

## Decision

The card does not parse. It strips a producer's outer frame by exact line match and renders the remaining text as muted prose rows, folded by the shared `preview`.

`stripReminderFrame` removes the first and last lines only when they are a matched open/close pair, each alone on its line (`REMINDER_FRAME_LINE`). An unpaired tag line, a mismatched pair, or a tag mentioned mid-prose is left intact, so no body is silently truncated by a tag-like first line. Producers emit the frame as whole lines, which is what makes an exact match sufficient.

Model-facing text is untouched. The rejected alternative — escaping at the producer so the document parses — would have changed what the model reads.

Emptiness is decided on the stripped text rather than the styled rows. A palette wraps every row in escapes, so a blank body styled first yields one escape-only row that reads as a stray blank line under the header; testing `stripped === ''` renders the card header-only instead.

Removing the parse also removes the C1-expansion hazard it carried. `renderUnknownXml` had to escape parsed text because a character reference like `&#155;` expands to a control character the raw-source escaping never saw. Unparsed text cannot expand, so `&#155;` now renders literally and terminal-injection safety rests solely on `displayText`, which the `untrusted-controls` snapshot pins.

`renderUnknownXml` keeps its one remaining consumer: unknown tool results, where a genuine XML result is plausible and the root element is meaningful. Only `preview` is shared with the context card.

## Alternatives considered

**XML-escape `&` and `<` in every producer so the frame parses.** Rejected: it corrupts a model-facing contract to satisfy a presentation detail. The model would read `packages/&lt;group&gt;/&lt;pkg&gt;/` and `&amp;logo=deepseek` — and that badge URL is an instruction the model is told to copy verbatim into a pull request description. It also needs repeating in every current and future producer with nothing keeping them in sync.

**Escape only for display, keeping the model text intact.** Rejected: escaping display-side to make a parse succeed, then rendering the parse as a tree, reintroduces the placeholders-as-elements misreading. The text is prose either way, so parsing it buys nothing.

**A lenient HTML-style parser.** Rejected: `renderUnknownXml` declines by design so partial or mixed text renders unchanged rather than as a guessed tree. Loosening it trades a correct decline for a wrong tree, and would affect unknown tool results too.

## Consequences

Context cards render identically whatever their text contains: the frame row is gone in every case, prose survives verbatim, and the fold depends only on row count. Bodies lose the tree's two-space indentation and nested-element structure, which the re-recorded `surface-after-compaction-{narrow,wide}` snapshots show; a nested block such as `<available_skills>` now appears as the literal text it is in the model-facing payload. An empty frame renders header-only rather than leaving a blank row.

A character reference in context is no longer decoded for display, which is the correct reading of a payload the model receives literally.

## Testing

`packages/ui/tui/tests/tui.spec.ts` pins the frame stripped for a multi-line reminder, prose preserved for an unpaired tag pair (`<available_skills>` … `</other-tag>`), header-only rendering for an empty frame, and a body carrying both a raw `&logo=` and `packages/<group>/<pkg>/` that folds and survives verbatim through a `Ctrl+O` round trip. The one-line frame case pins that `&#155;` stays literal while a raw C1 byte never reaches the terminal. The `surface-after-compaction-{narrow,wide}` keyless snapshots were re-recorded for the lost indentation and the now-recorded muted styling; `untrusted-controls` is unchanged, holding the escaping contract. `examples/tui-agent`'s `multi-turn-conversation` terminal snapshot was refreshed too: it had been failing since the original foldable-context change on an unrelated stale row, where it still expected a width-padded `Context · plan-mode` header that no card has emitted since the header stopped passing through `Text`. Both changed files keep 100% statement and branch coverage.
