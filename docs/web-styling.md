# Web GUI Style Guide

English | [中文](web-styling.zh.md)

> **[The token system has been replaced—the table in § 1 is retained only for historical reference]** The `--bg-*`/`--text-*`/`--accent` token families documented here and their host package, `packages/client/web-ui`, were retired during the plugin refactor. The sole current token source is `packages/client/ui-theme/src/styles/`, which defines the `--dsw-*` system (a static color scale plus a semantic alias layer, with dark-mode overrides under `body[data-ds-dark-theme]`). The sheet is authoritative and component audits use it as the baseline. **The following rules remain in force**: CSS Modules + clsx, no component library, no Tailwind, no hard-coded color values in components, pair every font size with a line height, use spacing in multiples of 4, and do not put monospace last in the code font stack.

> Status: formerly a “living document” that evolved with `packages/client/web-ui`. The visual baseline came from empirical study of the deepseekchat frontend repository. The [web-styling-system RFC](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) owns the framework decisions and engineering constraints; this document does not repeat their rationale.

## 1. Design token table (authoritative definitions)

All tokens live in `packages/client/web-ui/src/style/global.css`: `:root` contains the light-theme values, and the `[data-theme='dark']` block overrides the same variables (columns that were not complete are marked as placeholders). Component CSS references tokens only and contains no literal color values.

### 1.1 Colors (two layers: comments identify the base-palette source, while variable names are semantic aliases)

| token | Light value | Dark value (placeholder) | Purpose |
| --- | --- | --- | --- |
| `--bg-base` | `#ffffff` | `#151517` | Page background |
| `--bg-layer` | `#ffffff` | `#232324` | Floating layer/panel |
| `--bg-sidebar` | `#f9fafb` | `#1b1b1c` | Sidebar background |
| `--text-primary` | `#0f1115` | `#f9fafb` | Body text |
| `--text-secondary` | `#61666b` | `#cfd3d6` | Secondary text |
| `--text-tertiary` | `#81858c` | `#adb2b8` | Supporting/descriptive text |
| `--border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` | Subtle separator (sidebar right edge) |
| `--border-l2` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.12)` | Standard border |
| `--hover-bg` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` | Hover-state background |
| `--active-bg` | `rgba(38,49,72,.1)` | `rgba(255,255,255,.14)` | Pressed/active-state background |
| `--accent` | `#3964fe` | `#5686fe` | Brand blue (deepseek-500; one step lighter in dark mode) |
| `--accent-soft` | `#edf3fe` | `#28313f` | Soft brand background (emphasis blocks) |
| `--accent-item` | `#e4edfd` | `#35363a` | Selected sidebar-item background |
| `--bubble-bg` | `#edf3fe` | `#2c2c2e` | User-message bubble background |
| `--ok` / `--error` / `--warn` | `#22c55e` / `#ec1313` / `#f59e0b` | Same values | Semantic status colors |
| `--text-on-solid` | `#ffffff` | Same value | Text on solid backgrounds (accent/error badges, etc.) |
| `--ok-soft` / `--error-soft` | `#e6faed` / `#fee2e2` | `#233c2c` / `#570c0c` | Soft semantic status backgrounds (badges); green-100/red-100, with the 900 shades in dark mode |
| `--color-frame-mux` / `--color-frame-host` | `#8250df` / `#0969da` | Same values | RPC debugger direction colors (project-specific, not part of the baseline) |
| `--frame-mux-soft` / `--frame-host-soft` | `rgba(130,80,223,.1)` / `rgba(9,105,218,.1)` | Same colors at `.24` | Soft direction-color backgrounds (badges) |
| `--scroll-color` / `--scroll-color-hover` | `rgba(0,0,0,.08)` / `.15` | `rgba(255,255,255,.15)` / `.24` | Scrollbar colors (for `.scrollable` only) |

### 1.2 Non-color tokens

| token | Value | Description |
| --- | --- | --- |
| `--font-ui` | `Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | Body-text stack |
| `--font-mono` | `Menlo, Monaco, Consolas, 'JetBrains Mono', 'Courier New', sans-serif` | Code stack; **do not put monospace last** (prevents SimSun fallback for Chinese on Windows) |
| `--fw-strong` | `600` | Unified bold weight |
| `--ease` | `cubic-bezier(.4,0,.2,1)` | Sole easing curve |
| `--dur` / `--dur-fast` / `--dur-slow` | `.2s` / `.1s` / `.3s` | Three transition durations |
| `--radius-s` / `--radius-m` / `--radius-l` / `--radius-bubble` / `--radius-xl` | `8px` / `12px` / `16px` / `22px` / `24px` | Semantic radius steps: small controls / list items and blocks inside panels / floating layers / bubbles / input cards (same as the baseline inputWrapper); use `999px` directly for pills |
| `--shadow-panel` | `0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)` | Floating-layer shadow (baseline lv3) |
| `--shadow-float` | `0 0 1px rgba(0,0,0,.24), 0 4px 12px rgba(0,0,0,.06), 0 16px 48px rgba(0,0,0,.16)` | Strong floating panel (enhanced lv3, such as the RPC debugger overlay) |
| `--shadow-card` | `0 4px 10px rgba(0,0,0,.02), 0 2px 4px rgba(0,0,0,.04)`; dark value `none` | Subtle input-card shadow (baseline: borders plus a subtle shadow distinguish same-color light surfaces; a lighter background distinguishes dark surfaces, with the shadow disabled) |

Font sizes and spacing are **not tokenized** (matching the baseline repository's decision): components specify font sizes in px and **always pair them with line heights**. Common pairs are 16/24 (bubbles), 14/22 (UI default), and 12/18 (supporting text); spacing uses multiples of 4.

## 2. Visual baseline (from deepseekchat)

- Sidebar: width `260px + 1px` right border (`--border-l1`); background `--bg-sidebar`.
- Sidebar items: height `40px`, radius `--radius-m`, font size 14px; hover background `--hover-bg` or a sidebar-specific gray; **selected items use `--accent-item` without changing text color**.
- Sidebar group headings: 12px / weight 500 / `--text-tertiary` / sticky at the top (using the sidebar background to cover scrolling content).
- Conversation column: centered at `max-width: 840px`, reduced to 712px below 1024px.
- Message stream: **only user messages have bubbles**: background `--bubble-bg`, radius `--radius-bubble`, padding `10px 16px`, font size 16px/24px, and `max-width: calc(100% - 88px)`; **assistant messages are a plain document flow without a background**.
- Message action bar: `opacity: 0` by default; fades in when its parent is hovered or contains focus (`--dur` + `--ease`).
- Input card: floats centered at the same width as the conversation column (840px, reduced to 712px below 1024px) with bottom spacing; radius `--radius-xl`, border `--border-l2`, background `--bg-base`, shadow `--shadow-card`; two internal vertical sections = textarea (16px/24px, minimum 2 lines, maximum 14 lines = 336px, auto-growing through a mirror div) + action row (a 34px primary round button nested at bottom right); focus does not change the border or shadow (matching the baseline).
- Primary input button (the three decisions made on 2026-07-20, visually based on the Codex App): a 32px solid circular icon button (inline SVG). Idle = `--accent` background with a white ↑ “Send” arrow; while running it changes in place to an accent ■ “Stop” icon on `--accent-soft` (the same color family, not a warning, and not red). **Input is locked while running** (decision 3, replacing the earlier hover-menu design): the textarea is disabled (gray, with draft content still visible), there is no queue/interjection menu, and Stop is the only action. When the turn ends, input unlocks and regains focus. Enter sends; Ctrl/Meta+Enter inserts a newline (the keyboard path is disabled with the locked input while running).
- Scrollbars: nearly invisible, darkening on hover, with `scrollbar-gutter: stable` so they do not consume layout space (always use `.scrollable`; see § 3.9).
- Four-quadrant RPC direction symbols (the official visual vocabulary, using the spatial metaphor that up goes to the server, down comes from the server; single line = client-initiated exchange, double line = server-initiated exchange):

| Symbol | Quadrant | Badge colors |
| --- | --- | --- |
| `↑` | client-request (unary outbound) | `--accent` / `--accent-soft` |
| `↓` | server-response (unary response) | ok `--ok`/`--ok-soft`, error `--error`/`--error-soft` |
| `⇟` | server-request (downlink stream) | mux `--color-frame-mux`/`--frame-mux-soft`, host `--color-frame-host`/`--frame-host-soft` |
| `⇞` | client-response (reply to server request) | `--accent`/`--accent-soft` at reduced opacity |

## 3. Style implementation rules (review checklist)

1. Colors, radii, motion, and font stacks reference only the § 1 tokens. Reject literal color values in component CSS (except for special effects such as gradient masks, which require an explanatory comment).
2. Component CSS must not contain `[data-theme]` selectors; dark-mode differences belong only in the global.css token table. If a theme must change a non-token value such as a gradient endpoint, define a local CSS variable in the component and have the theme block override only that variable (a variable bridge).
3. Use camelCase class names; use a single adjective for state classes (`.active` `.show`) and attach them with clsx: `clsx(styles.x, cond && styles.active, className)`.
4. Public components must accept `className` and merge it into the root element.
5. Do not use `composes`; share through tokens and extracted components.
6. Use `:global` only to pierce third-party or cross-package class names; do not use it to define new global classes.
7. All interaction transitions use `var(--dur*) var(--ease)` and transition only opacity / transform / background color / shadow. Wrap hover-only reveal elements in `@media (hover: hover)`.
8. Prefer opacity-based tokens for hover/active backgrounds because they compose over any elevation background; do not add new solid grays.
9. Apply the `.scrollable` utility class from global.css to every scroll container; do not write `::-webkit-scrollbar` inside components.
10. Put media queries at the end of the component CSS, next to the rules they override. The only current breakpoint is 1024px (where the conversation column steps down); record a second breakpoint in this document before adding it.
11. Dynamic styles in JS set only CSS variables (`style={{'--x': v}}`), while rules remain in CSS; do not assemble style objects in TSX to branch by theme or state.
12. Use only the three `--text-primary/secondary/tertiary` levels for gray text; do not add another gray.

## 4. File organization

- `src/style/global.css` always uses this section order: ① token table (`:root` + `[data-theme='dark']`), ② global foundations (box-sizing, body, button reset), ③ global utility classes (`.scrollable`, etc.; keep the total in single digits).
- Place each `*.module.css` beside the component with the same name; use one module file per component.
- Use the existing `css-modules.d.ts` wildcard declaration. Reassess introducing tcm to generate exact `.css.d.ts` files only after the component count exceeds 20.
- PostCSS feature allowlist: currently **no plugins** (flat CSS plus native nesting when needed). Record nested/custom-media in this document before introducing either.

## 5. Evolution rules and deviation log

- **Adding a token**: add it to the § 1 table first (including the dark-placeholder column), then use it in the component. Reject any new `--` variable that has not been added to the table (except for component-local variable bridges).
- **Deviating from the baseline**: if an implementation differs from any constant in § 2, add one row to the deviation table below (date / item / rationale).
- **Dark-table completion acceptance**: after `[data-theme='dark']` overrides every placeholder column in § 1, compare the RPC panel, sidebar, and conversation stream manually or with screenshots. Acceptance requires all three to match and no component-level theme selector to remain.

| Date | Deviation | Rationale |
| --- | --- | --- |
| (none) | | |

## 6. Related documentation

- [web-styling-system RFC](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) (decision record for the five framework rules and engineering constraints)
- Client consumption architecture and layered protocols: [Web client architecture RFC](../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md), [GUI layering and RPC protocol RFC](../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)
