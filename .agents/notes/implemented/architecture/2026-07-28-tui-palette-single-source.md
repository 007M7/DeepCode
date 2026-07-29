# Agent Note: One palette table, one role per meaning, printable by `/palette`

Status: implemented

English | [中文](2026-07-28-tui-palette-single-source.zh.md)

## Problem

The palette had fifteen roles built from escape codes written inline in `createPalette`, and three pairs of them resolved to the same SGR parameters: `added`/`success` were both `32`, `removed`/`error` both `31`, and on a light scheme `muted`/`dim` were both `90`. A reader picking `added` or `muted` believed they had chosen a distinct tone; they had chosen an alias. Nothing enumerated the roles, so no reader could compare them, and the codes existed only as literals at their use site.

That hid a real defect for as long as it took a user to notice it. `dim` deliberately substituted ANSI 90 on light schemes, on the recorded theory that "SGR 2 lightens text on a light background." But lightening is precisely what a recessed tone must do, and ANSI 90 is a fixed hue: on a light theme whose default foreground is a soft gray, bright black is *heavier* than ordinary text. Every surface the TUI called dim — tool-card bodies, the timing footer, injected context, dialog chrome — therefore rendered as the most prominent text on screen, inverting the one relationship the role exists to express. The role named `dim` was the least dim thing in the transcript.

Nothing prevented the inversion from being introduced, and nothing revealed it afterwards. There was no listing to compare tones in, and terminal captures report escape codes rather than rendered luminance, so reading `\x1b[90m` and concluding "gray, therefore recessed" is a mistake a reader repeats indefinitely without a rendered sample to check against.

A second hazard was latent in the same design. SGR has no color stack: a nested span's close emits `39` (default foreground), not the enclosing color, so wrapping colored text in a second color silently drops the outer color for the remainder of the line. Only the type `(text: string) => string` guarded that, which is to say nothing guarded it.

## Decision

`paletteSpec(scheme)` is the single table of every SGR code the TUI may emit. Each entry carries `open`, `close`, and a `purpose` string. `createPalette` derives its wrappers by iterating `COLOR_ROLES` and `ATTRIBUTE_ROLES` over that table, and the `/palette` command prints it, so a role cannot exist in the palette without appearing in the listing or the reverse. No component writes an escape sequence of its own. The startup banner's brand gradient stays the one deliberate exception, since fixed brand color is its point.

`close` MUST reset every SGR group `open` sets. This is stated on `ansi` because the roles that violated it did so silently: `dim` opened `2;39` while closing only `22`, leaking a foreground reset past its own span.

Roles that resolved to the same escape are merged rather than kept as aliases. `muted` folds into `dim`, `added` into `success`, and `removed` into `error`, leaving seven colors and five attributes. `accent` becomes ANSI 95, the tone this terminal actually reads as emphasis, and the single-use `accent2` is deleted rather than kept as a second accent.

`dim` is `2;39` closing `22;39` on both schemes. SGR 2 fades relative to whatever foreground the terminal is using, which is the only way to land *below* `text` on a light and a dark theme with one code; `39` pins the starting foreground to the default so the tone does not inherit a caller's color. Only `code` still varies by scheme, because ANSI 36 is genuinely hard to read on a light background.

Colors and attributes are separately typed. A `ColorRole` takes `Colorable` and returns `Colored`; an `AttributeRole` is generic and preserves its argument's type. So `bold(accent(x))` and `accent(bold(x))` both compile, `accent(error(x))` does not, and — because the brand survives an attribute layer — neither does `dim(bold(success(x)))`.

## Alternatives considered

**Keep ANSI 90 for `dim` and adjust the surfaces that looked wrong.** Rejected: the surfaces were right and the tone was wrong. Every consumer of `dim` wanted the same thing, so the fix belongs in the one role, not in each caller.

**Plain SGR 2 without the `39`.** Considered; the user compared both rendered against their own background. Both read as genuinely dim, and `2` alone is the smaller change, but `2;39` guarantees the span starts from the default foreground rather than inheriting a caller's color, which matters wherever `dim` wraps content that may already be styled.

**Keep `muted` and `dim` as separate names against future differentiation.** Rejected: they resolved to one escape on one of the two supported schemes, and a name that sometimes aliases another is worse than one name. Reintroducing a second recessed tone is a new decision, to be made when a consumer needs it.

**Enforce the no-nested-color rule by convention and review.** Rejected: the rule is mechanically checkable and the failure is invisible — a dropped outer color looks like a rendering quirk, not a bug. The brands cost two type aliases and caught four deliberate violations in a compile check.

**A runtime guard that strips or rejects nested colors.** Rejected: it moves a statically decidable error to run time and would have to allocate on every styled span, in the render hot path.

**Print the palette to stdout from a script instead of a TUI command.** Rejected: the point is to see the tones the *running* TUI produces in the *user's* terminal, under the scheme it actually resolved. A script cannot report the live scheme, and this specific bug was invisible outside the real terminal.

## Consequences

The listing is now the fastest way to find a palette defect: `/palette` shows every role painted by its own code beside the SGR pair it reports, so a tone that misbehaves is visible next to its neighbours instead of inferred from escape numbers. It also reports the resolved scheme, which surfaced that scheme detection is not stable across launches — an unrelated bug this change makes observable but does not fix.

Four role names disappear from the palette, and `muted` leaves the public extension `TuiTheme`; an extension that wants a recessed tone uses `dim`. Merging the diff pair means `success` and `error` each carry two meanings, which is honest about there being one green and one red rather than implying a diff-specific palette.

The brands introduce a small friction: an array literal seeded with a colored string infers `Colored[]`, so two call sites now annotate `string[]` explicitly. That is the cost of the guarantee, and it appears at declaration sites rather than in styling expressions.

`accent` moving to 95 repaints twenty-four call sites, including Markdown headings and links, dialog borders, and the prompt. That is a visible change to surfaces beyond the reported defect, made because a single emphasis color is the point of the reduction.

## Testing

`packages/ui/tui/tests/tui.spec.ts` asserts `/palette` prints every name and `purpose` in `paletteSpec` and that each row carries the spec's own open code, so a role added to the table without a listing entry, or a listing that reports one code while rendering another, fails. Verified by construction: truncating the attribute loop makes the test fail rather than pass silently.

The scheme-detection test previously pinned `dim` changing between schemes, which is no longer true; it now pins scheme-independent `dim` alongside the `code` role that does vary. The blank-row and running-glyph tests carry the new SGR pairs. The no-nested-color rule is verified by compiling deliberate violations against the project's own tsconfig, where the four color-over-color expressions are rejected and the five legal attribute compositions are not.
