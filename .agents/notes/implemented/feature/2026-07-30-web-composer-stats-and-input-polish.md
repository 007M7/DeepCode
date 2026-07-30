# Agent Note: Web composer stats detail and input-zone polish

Status: implemented

English | [中文](2026-07-30-web-composer-stats-and-input-polish.zh.md)

## Problem

The web composer footer showed a single joined stats string (cache/tokens/turns/steps) in its own stack row, visually detached from the input card and missing the design's duration and token-split details. The input zone itself had accumulated per-entry spacing hacks: dock strips carried their own margins, the sticky seat sat on a solid fill that clipped the transcript hard, the back-to-bottom control cleared the composer by a hardcoded offset that broke as the draft grew, and the goal and todo strips disagreed on surface color and column width.

## Decision

**The stats line renders inside the InputBar's width column through a new `footer` owner prop and expands to the design's grouped detail row; the composer stack owns one 8px rhythm; the seat fades the transcript through a fixed 36px token-bound gradient; the back-to-bottom control follows a live `--dsh-composer-height`; goal and todo share one 752px tip-fill column.**

- `'conversation.composer.dock'` entries reach the page as the `ComposerBarOwnerProps.footer` slot, rendered under the card inside the bar's `.root`, so the stats line and the card share one width constraint. `StatsLine` derives everything client-side from the snapshot: turns/steps, LLM wall time from assistant `timing` (`completedTime - stepStartTime`), tool wall time from tool-result `time - callTime` pairs, prompt/output token split with cache-read folded into input, and cache-hit percentage. Groups render pipe-separated and drop out whole when empty; `formatTokens` (517 / 12.2K / 1.2M) and `formatDuration` (45.2s / 2m42s) are exported for tests. Durations cover only in-window nodes — the README owns that limitation.
- `.composerStack` carries `gap: 8px` and entries carry no outer margins (QueueDock's margin removed), so a dock entry that renders null costs nothing. GoalBar is the one deliberate exception: `margin: 0 auto -10px` cancels the gap and tucks its square bottom edge 2px under the card.
- The sticky seat's background is a `linear-gradient` from `color-mix(bg-base 0%, transparent)` at 0px to solid `bg-base` at 36px — pixel stops, not the figma export's percentage, so a growing draft widens only the solid region; `color-mix` keeps both themes fading from their own base.
- A `useCallback` ref on the seat attaches a ResizeObserver that publishes `--dsh-composer-height` on the scroll body; ChatView's back-to-bottom slot computes `bottom` from it (152px first-paint fallback) instead of the prior hardcoded 168px.
- The textarea's 52px two-line floor applies to the hero variant only; the docked composer collapses to content height. Goal and todo strips both use the 44px-gutter / 752px-cap column with the todo `tip` fill and l1 border; the todo header is compacted (13/20 type, 8+8 padding) so its collapsed height equals the goal strip's 38px.

## Alternatives considered

**Percentage gradient stops (the figma export's 24%).** Rejected: the stop scales with seat height, so a tall draft stretches the fade band over most of the transcript; the fixed 36px band equals the design's 24% at the resting ~150px composer and stays constant as the composer grows.

**A skeleton-owned dock column with a generic "bottommost entry tucks" contract.** Built and backed out in review: a `.inputDock` wrapper owning width/rhythm plus `--dsh-dock-tuck-*` vars on `:last-child` would retarget the tuck automatically on reorder, but it rewrote every entry and the GoalBar DOM ahead of a pending merge. Per-entry CSS with GoalBar owning its own tuck was chosen; the generic column remains available if dock entries multiply.

**Backend-supplied duration fields for the stats line.** Unnecessary: assistant `timing` and tool call/result pairs already reach the snapshot, so wall times fold client-side with no new session event or host projection.

**Keeping the stats line as a composer-stack sibling.** Rejected: as a stack row it carried its own width constraint that drifted from the card's; as the bar's `footer` both share one column and the stats participate in the seat's sticky/gradient region by construction.

## Consequences

The stats row now reads turns/steps, LLM and tool durations, cache hit, and input/output tokens at a glance, at the cost that durations cover only the loaded event window (README Known Limitation). The one-gap stack rhythm makes dock spacing composition-independent, but GoalBar's tuck is positional: it must stay the bottommost dock entry (`order: 1`) or its negative margin tucks it under the wrong neighbor. The fade band is a constant 36px, so any future design retune is one stop value. `chat-stats-bash-sample.spec.tsx` pins the derivation (timing/tool folds, token split), both formatters, the grouped render, and the zero-renders-during-streaming acceptance.
