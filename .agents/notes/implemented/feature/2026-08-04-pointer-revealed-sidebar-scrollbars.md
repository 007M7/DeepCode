# Agent Note: The sidebar's scrollbars follow the pointer

Status: implemented

English | [中文](2026-08-04-pointer-revealed-sidebar-scrollbars.zh.md)

## Problem

The sidebar's session list overflows after a handful of sessions, and from that point its scrollbar is drawn permanently — in a column that is at rest most of the time, next to rows whose own chrome only appears on hover. It is the one piece of always-on furniture in the sidebar, and nothing about it is actionable until someone reaches for it. The product ask (2026-08-04) is to draw it only while the pointer is over the sidebar, with a short tail so it does not blink out on the way past.

## Decision

`SidebarRoot` tracks the pointer over the whole column and carries a `quietBars` class whenever it is outside. The rule that class selects rebinds ui-theme's indirection pair — `--dsh-scrollbar-thumb` and `--dsh-scrollbar-thumb-hover` — to `transparent`, so every scroll region nested under the column draws no thumb. The session list is the only one today; a future one inherits the behavior rather than opting into it.

The tail is `SCROLLBAR_LINGER_MS = 2000`: `pointerleave` starts a timer, `pointerenter` cancels a pending one, and only the timer firing puts the class back. A pointer that crosses the column's edge and returns — travelling around a portalled menu, or overshooting on the way to a row — never sees the thumb blink.

The pointer surface is the column, not the list. A pointer heading for the bar crosses the logo row, the New Session capsule, and the search field first, so revealing on the list alone would surface the bar only once the pointer was already among the rows.

`transparent` is what makes the reveal free of layout. `scrollbar-gutter: stable` on the list exists so rows never move ([the gutter note](../bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md)); rebinding a colour leaves that reservation in force, so the thumb appears in space the list was already holding for it.

The indirection pair rather than a rule on the list, because that pair is ui-theme's documented rebinding seam: one declaration reaches both rendering paths (the WebKit pseudo-elements and Firefox's `scrollbar-color`), and custom properties inherit, which is what makes the column — rather than each scroll region in it — the thing that owns the state.

That widens the rebinding contract, so its gate states the new shape rather than accepting it by silence: `ui-theme/tests/scrollbar-styles.spec.ts` now admits exactly two rebind targets, an `-l2` token pair or `transparent`, and rejects everything else — an l1 rebind, which only restates the base-surface default under a name that reads as an elevation, and a literal colour, which leaves the palette.

## Alternatives considered

**CSS `:hover` on the column, with no JavaScript state.** The whole mechanism in one rule, and it cannot express the tail: the bar would vanish on the frame the pointer crossed the edge, which is exactly when a pointer is travelling to the conversation or around a portalled menu. The ask names the tail, and a hover-only version reads as flicker.

**Keep it in CSS and get the delay from a transition,** by registering `--dsh-scrollbar-thumb` through `@property` so the custom property becomes animatable and a `transition-delay` could hold the colour. Rejected on cost and on reach: the registration is global to every surface that reads the pair, for one column's timing, and the WebKit scrollbar pseudo-elements this palette actually renders through do not reliably transition — the delay would be specified where it cannot be observed.

**Hide the bar itself** — `scrollbar-width: none`, or `display: none` on `::-webkit-scrollbar`. Rejected because it takes the reserved band with it: the bar would reappear by re-taking 8px and shift every row sideways under the pointer that revealed it, which is the regression the gutter reservation was added to fix.

**Draw an overlay thumb in the app** and hide the native bar entirely, which is what a fully custom fade would need. It buys arbitrary styling and costs hit-testing, drag, wheel, momentum, and both palettes' hover states — a large owned surface for a cosmetic gain, in a client whose scrollbars are already themed through tokens.

**Scope the reveal to the scrolling list rather than the column.** Fewer elements involved, and it puts the reveal at the wrong boundary: the pointer reaches the rows last, so the bar would appear after the user is already reading them, and every other scroll region added to the sidebar later would have to opt in by hand.

**Reveal on scroll events too,** so a keyboard- or touch-driven scroll shows the bar. Rejected as drawing an affordance the input that triggered it cannot use; the rows themselves already show that the list moved.

## Consequences

- A list scrolled by keyboard or by a touch drag shows no thumb once the linger passes, since neither leaves a pointer over the column.
- The column starts quiet on a cold load and stays so until the pointer first moves over it. A pointer already parked there when the page loads fires nothing until it moves, which is the browser's rule rather than this shell's.
- An elevated surface nested in the column that rebinds the pair to l2 for its own elevation overrides the quiet state and keeps its bar drawn. Nothing in the sidebar does this today; the settings panel portals out of the column entirely.
- The shell's DOM now carries a state class, so ui-sidebar's shell snapshots pin `quietBars` and a regression in the default state is a snapshot diff rather than something someone has to notice in a screenshot.

## Testing

`packages/client/ui-sidebar/tests/pointer-scrollbars.spec.tsx` drives the class through the transitions with fake timers: revealed on entry, still revealed one millisecond before the linger closes, quiet one millisecond after, and cancelled by a return within the window. It also unmounts mid-linger and asserts no timer survives — a pending hide firing into a dead component is the failure this shape is prone to. The events are `pointerover`/`pointerout` carrying a `relatedTarget`, because React synthesizes enter and leave from those and ignores the raw ones.

`packages/client/ui-sidebar/tests/scrollbar-quiet-styles.spec.ts` reads the sheet: the rule states both halves of the pair — rebinding the resting thumb alone would leave the hover colour painting the moment the pointer reached the bar — and states no `scrollbar-gutter`, which belongs to the scrolling region.

`apps/web/tests/sidebar-scrollbar.e2e.ts` is where the two halves meet a real engine. It parks the pointer over the list before every colour reading, since a scenario that never moves the mouse would measure the quiet state throughout and read as vacuous green. Its own test then moves the pointer away, asserts the thumb is still drawn on the leave itself, polls until it resolves to `rgba(0, 0, 0, 0)`, and re-measures the geometry there to prove the reservation held while the bar was hidden. The committed golden records the thumb at both pointer positions in both palettes.

The e2e's control is a mutation, and it needs the plugin's own bundle: dropping `quietBars` from the shell, rebuilding `@deepseek-ai/dsh-client-ui-sidebar` and only then `build:web`, turns that test red on the thumb resolving to `rgb(229, 229, 229)` where it expects `rgba(0, 0, 0, 0)`. Rerunning `build:web` alone exercises a stale bundle and passes with the change removed, which is the trap [the gutter note](../bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md) documented.
