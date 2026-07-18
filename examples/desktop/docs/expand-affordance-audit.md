# Expand-affordance audit (fix/expand-affordance, 2026-07-18)

User report (针对对话流里 `trace · ↑20 ↓58` 折叠行, 2026-07-18):
> "没有展开时候，看上去让人不是很知道它点击是可以展开的……哪怕加一个那种折叠小箭头……你这个东西看上去只是一行小字，人们根本不知道点它还可以展开（Tree / Timeline / Graph）三个。它展开对研究员蛮有信息增量的。包括其他点击可以展开的，看看是不是也都有这个问题。"

## Design language (density-spec §4/§7 + existing precedent)

Two indicator positions in the app today — we lock these two, no third:

- **Row-head left** (▸ collapsed / ∨ expanded): Fields tree, CoT, tool-block,
  card-diff hunk, trace card, trace-event-row, trace-header rows, trace-usage,
  compact-card `.shadowed-expander`, edit-rerun-header. **This is the default**.
- **Row-tail right** (∨ subtree fold decoration): trace-tree parent row (task #38).
  Reserved for tree rows where the fold applies to a subtree, not the row.

Glyph: `▸` (U+25B8) collapsed, `∨` (U+2228, keyboard-typeable) or the same `▸`
with `transform: rotate(90deg)` when `[open]`. Existing precedent uses
rotate-90 exclusively — we match. **Color**: `var(--muted)` — never accent,
never status-tinted. **No emoji** anywhere.

Every expandable row also gets `:hover` background highlight (second cue),
`aria-expanded` reflecting state (a11y + plugin-author示范), and
`title="Click to expand …"` tooltip on the P0 surface (trace drawer).

## Full inventory (28 `<details>` sites + native `<details>` fallbacks)

Judgement legend: **达标** = has visible ▸/∨ or rotating chevron in collapsed
state; **缺失** = no visual indicator in collapsed state.

| # | Surface (CSS selector / file:line) | Collapsed-state indicator | Judgement |
|---|---|---|---|
|  1 | `.turn-trace-drawer > .turn-trace-drawer-summary` (style.css:6949, assistant-turn.js:390, renderer.js:1451) — **user-called-out P0** | none — muted text only | **缺失** |
|  2 | `.context-card summary` (style.css:244) | `⌄` down-arrow, rotate on `[open]` | 达标 |
|  3 | `.tool-block summary` (style.css:360) | CSS border-triangle chevron, rotate on `[open]` | 达标 |
|  4 | `.card-diff-hunk-summary` (style.css:1452) | `▸`, rotate on `[open]` | 达标 |
|  5 | `.tool-json-section > summary` (style.css:1524) | `▸`, rotate on `[open]` | 达标 |
|  6 | `details.prompt-blocked-row > summary.pb-row-head` (style.css:1619) | none — pb-row-icon (error ✗) + label only | **缺失** |
|  7 | `.devtools-row-summary` (style.css:1804) | none — glyph col carries type only | **缺失** |
|  8 | `.recall-card summary` (style.css:2267) | `⌕` magnifier glyph (semantic, not fold) — but no rotation, marks recall action not "expandable" | **缺失** (semantic mismatch) |
|  9 | `.compact-card summary` (style.css:2316) | dashed `----divider----` treats the row as a divider; user model = compact card is a break, not a chip. body always open via `.shadowed-expander` inner. | 达标 (divider affordance is a distinct pattern; inner expander has its own ▸ — see #10) |
| 10 | `.compact-card .shadowed-expander-summary` (style.css:2383) | `▸ `, rotate on `[open]` | 达标 |
| 11 | `.trace-card summary` (style.css:6022) | `▸`, rotate on `[open]` | 达标 |
| 12 | `.trace-event-row > summary` (style.css:6088) | `▸`, rotate on `[open]` | 达标 |
| 13 | `.trace-header-{system,tools,prefix} > summary` (style.css:6160) | `▸`, rotate on `[open]` | 达标 |
| 14 | `.trace-header-tool > summary` (style.css:6191) | `▸`, rotate on `[open]` | 达标 |
| 15 | `.trace-usage-table > summary` (style.css:6225) | `▸`, rotate on `[open]` | 达标 |
| 16 | `.inject-card summary` (style.css:6290) | family icon (paperclip/etc.), muted — no fold cue and no rotation | **缺失** |
| 17 | `.subagent-trace > .subagent-trace-summary` (style.css:6767) | `.subagent-trace-glyph` (kind letter, no rotation) | **缺失** |
| 18 | `.raw-inject-card > .raw-inject-summary` (style.css:6844) | `.raw-inject-icon` (kind letter) + accent badge chip | **缺失** |
| 19 | `.raw-inject-l2 > summary` (style.css:6913) | none — label only | **缺失** |
| 20 | `.runtime-row-head` (style.css:7096) | status dot only | **缺失** |
| 21 | `.context-page-row-summary` (style.css:9127) | none — turn# + counters only (row is per-turn context history) | **缺失** |
| 22 | `.trace-detail-row-fields-summary` (style.css:9656) | none — bracket glyph + label | **缺失** |
| 23 | `.trace-detail-section > summary` (style.css:9797) | none — label + controls only | **缺失** |
| 24 | `.trace-detail-attr-group > summary` (style.css:9854) | none — label only | **缺失** |
| 25 | `.trace-detail-field-block > summary` (style.css:9887) | none — key + copy button | **缺失** |
| 26 | `.edit-rerun-header-summary` (style.css:10501) | CSS border-triangle chevron, rotate on `[open]` | 达标 |

Plus custom (non-`<details>`) toggle patterns scanned via
`grep classList.toggle('collapsed'\|.hidden` — the only click-to-fold custom
sites are:

- **panels-c-controller.js:260** — Tasks drawer with explicit `Show`/`Hide` text button. Discoverable text label; treat as 达标.
- **trace-detail-pane.js:1743** — `dimRow.classList.toggle('hidden', !isTurn)` is a visibility gate driven by row type (turn vs step), not a user-clickable fold. N/A.

## Fold-count summary

- Total expandable surfaces: **26** `<details>` sites + 1 explicit-text button.
- 达标 (visible indicator): **12** (context-card, tool-block, card-diff, tool-json, `.shadowed-expander`, all trace-card/trace-event/trace-header/trace-usage, compact-card divider, edit-rerun, panels-c Show/Hide).
- **缺失** (no visible fold cue): **14** — items 1, 6, 7, 8, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25.
- Post-fix target: 14 → 0. All缺失 sites gain a row-head-left `▸`/`∨` marker via
  a single reusable CSS class + per-selector `::-webkit-details-marker` reset
  where the site already has one, or add both marker-hide + ::before.

## Fix plan

Two new reusable CSS classes appended to the tail of `style.css`:

```css
/* Universal fold-affordance decoration for <details> summaries that
 * don't have a semantic glyph carrying the "click to expand" hint.
 * Prepend on any summary that lacks a ▸/∨. Pairs with
 * `.aff-summary::-webkit-details-marker { display: none }` on the
 * summary itself. Keep in sync with the trace-card ▸ language. */
.aff-summary { list-style: none; }
.aff-summary::-webkit-details-marker { display: none; }
.aff-summary::before {
  content: '\25B8';                 /* ▸ */
  color: var(--muted);
  font-size: 10px;
  width: 1em;
  flex: 0 0 auto;
  display: inline-block;
  transition: transform 120ms ease;
}
details[open] > .aff-summary::before { transform: rotate(90deg); }
.aff-summary:hover { background: var(--surface-hover); }
```

Per site, we add the `aff-summary` class to the JS builder (or extend the
existing selector directly in CSS when the class is stable and heavily-tested).
For sites like `.raw-inject-summary`, `.inject-card summary`, etc. where a
semantic icon already sits at the head, the `▸` slots in *before* that icon —
so the reader reads: **▸ [family-icon] [label]** collapsed, **∨ [family-icon]
[label]** expanded.

**Two-position grammar exception** (per §4 of density-layering-spec.md's
"row-head-left OR row-tail only, max 2 position grammars app-wide"): where
the head is already occupied by a **semantic status glyph** we can't demote —
specifically `.recall-card` (⌕ semantic glyph) and `.subagent-trace`
(✓/✗/▸-running status glyph) — the fold chevron goes at the row **tail** via
`::after` with `margin-left: auto`, so it doesn't clobber the semantic head
glyph. This mirrors task #38's trace-tree parent-row right-side `∨`
precedent. All other 缺失 surfaces use head-left `::before`.

The `.turn-trace-drawer-summary` also gets a `title="Click to expand Tree /
Timeline / Graph views"` attribute (task user-facing tooltip).

`aria-expanded` (mirrors `.open` state via a MutationObserver on
`toggle` event) is set on every fixed summary so plugin authors have
a working accessibility reference.

## Test locks

- Extend `test/renderer-first-turn-drawer.test.js` with an assertion that
  the trace drawer summary has `aria-expanded=false` collapsed, `true` after
  `drawer.open = true`.
- New `test/expand-affordance.test.js`: for every fixed summary selector,
  assert `getComputedStyle(el, '::before').content` is `"▸"` in collapsed
  state and its ancestor has `aria-expanded=false`; after `.open = true`
  parent has `aria-expanded=true`. Wire the CSS class detection instead of
  ::before (jsdom doesn't render pseudo-elements) by asserting the class
  presence and `open` reflection.

## Verification

- Isolated Electron: user-data-dir `~/.dsh-demo-affordance/`, remote-debug
  port `9269`; kill on exit; screenshots to `docs/qa-affordance/` per site
  (collapsed + expanded pair).

### Verification results (2026-07-18)

Ran `scripts/qa-cdp-shoot-affordance.mjs`; mounted 5 representative
fixtures (trace-drawer, runtime-row, inject-card, subagent-trace,
recall-card) inside the real renderer's stream container and shot
collapsed/expanded pairs plus a hover shot for the P0 trace drawer.

Assertions verified live via CDP `getComputedStyle` and DOM inspection
(`docs/qa-affordance/aria-assertions.json`):
- Every collapsed summary has `aria-expanded="false"` AND a `::before` or
  `::after` chevron marker (`content: '▸'`).
- Every expanded summary flips to `aria-expanded="true"` (the toggle event
  wiring in `initDetailsAriaObserver` in `renderer.js`, backed by
  `wireDetailsAria` in `details-aria.js`).
- subagent-trace row-tail placement confirmed (`hasAfter: true`,
  `hasBefore: false`) — head keeps its status glyph.
- recall-card carries both glyphs (⌕ head + ▸ tail) as designed.

Screenshots:
- `docs/qa-affordance/01-collapsed-all.png` — all five fixtures collapsed
- `docs/qa-affordance/02-trace-drawer-hover.png` — P0 hover state
- `docs/qa-affordance/03-expanded-all.png` — all five fixtures expanded
- `docs/qa-affordance/04-trace-drawer-collapsed.png` — P0 collapsed close-up
- `docs/qa-affordance/05-trace-drawer-expanded.png` — P0 expanded close-up

Tests: `test/expand-affordance.test.js` 9/9 pass; the three static gate
tests (`emoji-ban-static`, `renderer-collisions`, `style-css-static`) 9/9
pass; full suite 1513 pass / 1 pre-existing `artifact-server.test.js`
`electron` module-resolution failure unrelated to this batch.

### Summary count

- 达标 (pre-existing markers, no change needed): **12** — lines 34, 36, 40,
  42, 43, 44, 45, 46, 47, 51 (approval steer chip), 60 (edit-rerun), and
  57 (Show/Hide text button, non-`<details>` explicit textual toggle).
- 缺失 (was missing a fold indicator before this batch): **14** — the
  14 selectors listed in `AFFORDANCE_SELECTORS` in
  `test/expand-affordance.test.js`.
- 已补 (fixed in this batch): **14** — 13 via `::before` (row-head-left)
  + 1 via `::after` on `.subagent-trace` (row-tail because head carries
  a status glyph, per the grammar exception documented above; recall-card
  also uses `::after` because ⌕ semantic glyph already sits at the head).
- Test locks: `test/expand-affordance.test.js` — 9 tests, all green.

### Postmortem: QA-probe overlay-write leak (fixed same day)

Symptom (reported by team-lead 2026-07-18): the user's real
`~/.dsh-desktop/user-overlay.cordis.yml` was rewritten with a
worktree-relative include path (`../harness/dsh-demo-worktrees/lane-affordance/config/daemon-echo.yml`), breaking their live stdio-deepseek profile.

Root cause: `scripts/qa-cdp-shoot-affordance.mjs` isolated
`--user-data-dir` (Chromium userdata) but **not** `DSH_DESKTOP_HOME` (our
shell's config root, read at `src/main/plugins.js:580`,
`src/main/main.js`, `src/main/growth-log.js`, `src/main/profiles.js`).
Falling back to `~/.dsh-desktop`, my Electron instance — booted with
`cwd=WORKTREE` — triggered the Plugins-tab / onboarding path that
rewrites the overlay, resolving the base include relative to
`process.cwd()`.

Fix (this commit): the shoot script now sets **both** isolation roots
under `$TMPDIR`, seeds a minimal overlay with an *absolute* include path,
marks `.onboarded` before the shell boots, and rebuilds both directories
fresh each run. Precedent copied from `scripts/interactive-sweep-v2.mjs:145`.

Verification of the fix (this run):
- BEFORE `~/.dsh-desktop/user-overlay.cordis.yml`
  `b6c82b2dd9f9415d279bfadd93aeaf26a8a5cf9e8a67725088d575f8df2c9435`
- AFTER — identical hash. `stat` mtime unchanged (`Jul 18 08:04:13 2026`).
- All shell writes captured in `$TMPDIR/dsh-affordance-home/`
  (`.onboarded`, `config.json`, `growth-log.jsonl`, `user-overlay.cordis.yml`).

Impact on prior screenshots (01–05 in `docs/qa-affordance/`): none
substantive. The fixtures are pure DOM mounted inside the renderer's
`#stream`; they don't read profile state, wire adapters, or hit any
runtime. Which host profile happened to load underneath is irrelevant
to what the shots prove (▸/∨ chevrons visible in `::before`/`::after`
pseudo-elements, aria-expanded flips on toggle). Reshot cleanly under the
fixed isolation to close the audit trail — hashes above prove non-interference.

General rule for anyone else writing an Electron QA probe: **isolate both
`--user-data-dir` and `DSH_DESKTOP_HOME`** to a tmp directory. Isolating
only one is a footgun that will silently rewrite the real user's config.
