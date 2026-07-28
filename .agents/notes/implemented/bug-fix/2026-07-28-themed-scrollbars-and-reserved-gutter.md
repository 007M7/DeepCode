# Agent Note: The scrollbar tokens get their consumer, and the workspace list reserves its gutter

Status: implemented

English | [中文](2026-07-28-themed-scrollbars-and-reserved-gutter.zh.md)

## Problem

`design-platform.css` declares four `--dsw-alias-scrollbar-*` tokens (`bg-l1`, `bg-l2`, `hover-l1`, `hover-l2`) in both palettes, and no rule anywhere in the client read them. A defined token with no consumer is not a theme: every scrolling region rendered the user agent's own scrollbar, which knows nothing about the palette, so the dark theme showed a light native bar against dark surfaces.

The visible symptom that surfaced the gap was elsewhere. The workspace browser's session list (`.list` in `WorkspaceBrowser.module.css`) is the sidebar's only scrolling region, and each row's trailing content sits flush against the row's 8px right padding — `.time` in `rows/Rows.module.css` is `flex: none`, as are the action buttons that replace it on hover. An overlaid scrollbar therefore painted on top of the relative timestamp. Reserving space in that one list would have left the bar itself unthemed, so the two halves are one change.

## Decision

`packages/client/ui-theme/src/styles/scrollbar.css` is the sole consumer of the four tokens, and the fifth ui-theme sheet in the shell's import chain (`packages/client/web/src/base.css`). It follows `design-platform.css` there because it reads that sheet's tokens.

The rules sit on `body`, not `html`. `design-platform.css` declares the `--dsw-alias-*` tokens on `body`, with the dark overrides on `body[data-ds-dark-theme]`, and custom properties inherit only downward; an `html` rule resolves them to the guaranteed-invalid value, at which point `scrollbar-color` computes to `auto` and no theming happens at all.

`scrollbar-width` and `scrollbar-color` are declared on `body, body *` rather than once at the top. Inheritance would pass down the color already substituted at `body`, so a descendant rebinding the indirection could not change its own scrollbar; re-declaring makes each element substitute the variable as it sees it. `scrollbar-width` is not an inherited property in the first place, so it needs the per-element declaration regardless. The `::-webkit-scrollbar*` pseudo-elements are likewise not inherited and are matched unscoped.

Both halves read one indirection pair, `--dsh-scrollbar-thumb` and `--dsh-scrollbar-thumb-hover`, bound on `body` to the l1 (base-surface) tokens. **This is the rebinding contract, and it is the part the CSS alone does not state**: an elevated surface sets `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` and `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)` on its own container, and that one rebind reaches the standard properties and the WebKit pseudo-elements together. The pair is rebound as a pair; rebinding the resting thumb alone leaves the hover state on the base-surface token. Four surfaces rebind today: the command popup, the slash menu, the model-select panel, and the settings panel. The last two declare it on the elevated panel rather than on the scrolling descendant, because the elevation is a property of the surface and custom properties inherit down to whichever child actually scrolls.

The track and the corner stay transparent, so the thumb reads against whatever surface scrolls under it; only the thumb and its hover state carry a token color.

`.list` declares `scrollbar-gutter: stable`, which keeps the bar beside the rows instead of on top of them. `stable` rather than `auto` because `auto` reserves the gutter only while the list actually overflows: expanding a workspace group would then shift every row horizontally at the moment it starts scrolling. The reservation is unconditional and the rows never move.

## Alternatives considered

**Per-module `::-webkit-scrollbar` rules in each scrolling component sheet.** Rejected: the client has thirteen scrolling containers across nine packages, every one would carry the same block, and the fourteenth would ship unthemed with nothing failing. A skin driven by design tokens belongs in the package that owns the tokens.

**An opt-in utility class that each scroll container adds.** Same duplication removed, but the failure mode stays: a new scroll container is themed only if its author remembers the class, and the omission is invisible in review. The `body, body *` form has no opt-in step to forget; a container that genuinely wants a different bar overrides the indirection, which is the same mechanism elevated surfaces use.

**Bind the properties on `html`.** The natural place for a document-wide skin, and it fails measurably: with the rule on `html` a scroll container computes `scrollbar-color: auto` in chromium, because the alias tokens are not in scope there.

**Declare the properties once and let them inherit.** Fewer matched elements, and it breaks the rebinding contract — inheritance carries the substituted color, not the variable reference, so an elevated surface could not retint its own scrollbar. It is also incomplete on its own terms, since `scrollbar-width` does not inherit.

**Pad the rows instead of reserving the gutter (extra right padding on `.list`, or moving `.time` inward).** Rejected: padding applies whether or not a bar is present, so it costs horizontal room in the common short-list case, and it fixes exactly one container while leaving every other scrolling region's content under its bar.

**`scrollbar-gutter: auto` on `.list`.** The reservation appears when the list overflows, which is when the bar exists. Rejected because the sidebar's lists grow and shrink as groups expand, so the reservation would appear and disappear under the user's cursor and shift the rows with it.

## Consequences

- Every scroll container in the client draws the themed thumb: `rgb(229, 229, 229)` on a light base surface, `rgb(60, 60, 61)` on a dark one, and `rgb(84, 85, 87)` for a dark elevated surface that rebinds to the l2 pair.
- The two renderings are separately specified, so a change to the thumb's geometry or hover behavior has to be made twice — once in `scrollbar-width`/`scrollbar-color`, once in the pseudo-elements. Routing both through the indirection pair confines that duplication to the properties Firefox and WebKit do not share.
- `body *` matches every element, for two properties whose effect the user agent already limits to elements that actually scroll. The cost is a broad selector; the alternative was a rebinding contract that does not work.
- The workspace list is permanently narrower by the reserved band, at every list length. That is the trade the fix buys: stable row geometry instead of a timestamp that is legible only while the list is short.
- There is no track token in the palette, so a design that later wants an opaque track needs a new alias token rather than a literal color in this sheet.

## Testing

Three unit specs read the CSS text on disk. `ui-theme/tests/scrollbar-styles.spec.ts` scans the scrollbar token set out of `design-platform.css` rather than hardcoding it, so adding, renaming, or dropping a token moves the assertions with it, and checks that every token has a consumer and that each elevated surface rebinds a complete pair. `web/tests/base-styles.spec.ts` pins the import order and the existence of every sheet `base.css` names. `ui-workspace/tests/browser-styles.spec.ts` pins the gutter reservation on `.list`.

`apps/web/tests/sidebar-scrollbar.e2e.ts` covers the two facts only a real engine reports: the reserved band width, and the substituted `scrollbar-color`. It needs no model calls — the list only has to overflow — so it seeds cold sessions from an existing committed fixture read-only.

Confirmed in headless chromium on the built client by reading computed values, which is what distinguishes a working token chain from a syntactically valid one: a scroll container computes the l1 thumb color in each palette, and a container that rebinds the indirection computes the l2 color, proving the rebind reaches the computed value rather than only the custom property.

Headless chromium draws overlay scrollbars, so a reserved gutter there does not shrink `clientWidth`. The reservation shows up as a non-zero `offsetWidth - clientWidth` band on the list; client-area geometry alone does not demonstrate it, and an assertion comparing the time element's right edge against the client-area edge holds with and without the reservation, so it would pass or fail on the platform's scrollbar style rather than on the declaration under test.

Verifying browser-visible plugin CSS needs a rebuild `pnpm run build:web` does not perform. `WorkspaceBrowser.module.css` never reaches `apps/web/dist`: ui-workspace loads as a runtime plugin and its CSS is inlined into `packages/client/ui-workspace/lib/client.js`, built by that package's own `bundle` script. A negative control that reruns only `build:web` therefore exercises a stale bundle and passes with the declaration removed, which reads as a vacuous test rather than as an invalid control. Rebuild with `pnpm --filter @deepseek-ai/dsh-client-ui-workspace run bundle`, confirm the artifact by grepping `lib/client.js` for the declaration, then `build:web`. No script in the web lane does this: `test:web` runs `build:web` alone, so every scroll-region or plugin-CSS change hits the same trap.
