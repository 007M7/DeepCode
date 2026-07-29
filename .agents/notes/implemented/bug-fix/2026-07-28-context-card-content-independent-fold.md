# Agent Note: Context-card folding is independent of whether the text parses as XML

Status: implemented

English | [中文](2026-07-28-context-card-content-independent-fold.zh.md)

## Problem

[Foldable injected-context cards](../feature/2026-07-28-tui-foldable-context-cards.md) folded only the tree-rendered body. `ContextCardComponent.render` passed `expanded` and `maxOutputLines` into `renderUnknownXml`, which returns `undefined` when the text is not one complete XML document; the `undefined` branch then rendered the whole message as a single muted blob that consulted neither field. Unparsed context was therefore permanently expanded and inert under `Ctrl+O`.

The parser rejects far more real context than the fallback implied. `workspace-context` frames instructions in `<system-reminder>` and escapes only `</system-reminder>`, so any raw `&` or `<` inside the prose is an invalid entity reference or bogus tag that fails the whole document. A badge URL's `&logo=` does it, and so does any `a < b`. Observed on a live session log: two `workspace-instructions` cards rendered 254 and 85 identical rows collapsed and expanded, each with a literal `<system-reminder>` as the first body row, while a `dsh-tool-skill` card whose text happened to parse folded 113 rows to 46.

The user-visible symptom read as two bugs — the frame line was back, and nothing folded — but both are this one branch.

## Decision

Folding is a property of the card, not of the text. `preview` is exported from `packages/ui/tui/src/components/xml-tool-output.ts` and applied to the assembled body in `ContextCardComponent.render`.

`ToolCardComponent` had an inline copy of that head/tail/marker arithmetic; it now calls the same `preview`, so one function owns the fold rule for every transcript card. Where a tool card's tree body was already folded per child, re-applying the limit to the assembled rows is deliberate: the per-child budget bounds each child, not their sum, so many small children could still exceed the card's budget.

This note's fix kept the parse and made the fold independent of it. The card [no longer parses context at all](2026-07-28-context-cards-render-prose-not-xml.md), which also removed the residual frame row this fix could not suppress: an unparsed body had no parsed root to drop, so its first row stayed the literal `<system-reminder>`.

## Alternatives considered

**Escape `&` and `<` in `workspace-context` so the document always parses.** Rejected as the fix for this defect: it makes the fold work by making the parse succeed, leaving folding contingent on content. Any other plugin injecting arbitrary text, or any escaping gap, reintroduces the same symptom. Worth doing on its own merits — it would also drop the frame row — but the card must fold regardless.

**Pre-parse repair, or a lenient HTML-style parser.** Rejected: `renderUnknownXml` declines on purpose so partial or mixed text renders unchanged rather than through a guessed tree. Loosening it to satisfy a presentation budget trades a correct decline for a wrong tree, and affects unknown tool results too.

**Truncate in the `undefined` branch alone.** Rejected: it fixes the symptom while leaving two fold implementations whose agreement is unverified. Exporting `preview` removes the tool card's duplicate at the same time.

## Consequences

Every context card folds to `maxToolOutputLines` and responds to `Ctrl+O`, whatever its text contains. Tool cards whose tree body has many children can now fold where they did not, since the card total is bounded rather than each child.

## Testing

`packages/ui/tui/tests/tui.spec.ts` pins a context card whose text carries a raw `&` (a badge URL's `&logo=`, the observed real-world trigger): it is collapsed by default with the `Ctrl+O to expand` marker, hides a middle line, and reveals it on `Ctrl+O`. That test failed on this fix's parent commit, where the card emitted no marker.
