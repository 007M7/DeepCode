---
name: dsh-arch-diagram
description: Regenerate the DeepSeek Harness "System overview" architecture PNGs (English + Chinese) that the top-level README embeds. Reflects the current state of packages/* and docs/architecture.md. Use when the codebase adds/removes/renames services and the README diagram must be refreshed.
---

# dsh-arch-diagram

Produces `assets/arch-en.png` and `assets/arch-zh.png` in this repo — the two hero images embedded at the top of `README.md` and `README.zh.md`.

The pipeline is HTML + Chrome headless, so text quality, layout, and connector geometry are **deterministic** — every rerun produces the same output regardless of model.

Aesthetic is locked to the DeepSeek brand: light blue gradient background, brand-blue Cordis bar, sans-serif everywhere, no serif / no italic / no hand-drawn feel.

---

## When to use

- User asks to "regenerate" or "refresh" the Harness architecture diagram
- User points out `packages/` has changed (new services, renames) and the README diagram is stale
- User just added a new `packages/<family>/` or a new `ctx.*` service and wants the diagram to reflect it

## When NOT to use

- User wants a different diagram (Code Mode, Workflow fanout, agent lifecycle) — those belong in `docs/` and need their own skill
- User wants a different visual aesthetic (dark mode, hand-drawn, editorial-serif) — this skill is locked to DeepSeek brand

---

## Workflow

### 1. Enumerate current services from the repo

The diagram is grounded in two lists that live in the docs:

- **Default Services** — from `packages/core/*` and `docs/architecture.md`'s "Default Services" table. As of last refresh: `ctx.sessions`, `ctx.systemPrompt`, `ctx.tools`, `ctx.agents`, `ctx.agentLoop`.
- **Capability Services** — from the non-core capability packages and `docs/architecture.md`'s "Capability Services" table. As of last refresh: `ctx.llm`, `ctx.bash`, `ctx.sandbox`, `ctx.codeRuntime`, `ctx.fs`, `ctx.skills`, `ctx.web`, `ctx.compact`, `ctx.subagents`, `ctx.workflows`, `ctx.sessionPersistence`, `ctx.sessionQuery`.

**Do this**:

1. Read `docs/architecture.md`
2. Extract the two `ctx.*` tables verbatim
3. Cross-check against `packages/`: services live under `packages/core/*` (defaults) or under `packages/<family>/<package>/` (capabilities). The inner package dir mirrors the npm name without the `@deepseek-ai/dsh-` prefix — e.g. `packages/session-query/session-query/` publishes `@deepseek-ai/dsh-session-query`. Never assume the inner dir carries a `dsh-` prefix.

### 2. Diff against the current HTML templates

Read `harness-arch-en.html` and `harness-arch-zh.html` in this skill directory. Pull out the currently-rendered `ctx.*` names. Report the diff:

```
Default services: no change
Capability services: + ctx.<new>, − ctx.<removed>, ↻ ctx.<renamed>
```

### 3. Update the templates

If there are changes, edit both HTML files in place. Each card is one line:

```html
<div class="card"><span class="name">ctx.something</span><span class="desc">short description</span></div>
```

For a **new** service:
- Description is **short** — 2–4 words (EN), 3–6 chars (ZH)
- Ground the description in what the package's README or its `ctx.<name>.register()` **actually** does. Do NOT paraphrase from an abstract or invent capabilities the code doesn't have.
- Add the card in **both** languages, in docs order.

For a **removed** service: delete the card in both files.

For a **renamed** service: update the `.name` span in both files.

**Do not touch the layout**. Rows are:
- Top row (`row top`): exactly 5 default-service cards
- Bottom row (`row bottom`): 12 capability-service cards

If the capability count grows past ~13, the row gets visually tight. Stop and ask the user before shrinking fonts or wrapping to two rows.

### 4. Render to PNG

```bash
bash .agents/skills/dsh-arch-diagram/render.sh
```

Default output: `<repo>/assets/arch-en.png` and `<repo>/assets/arch-zh.png` — the paths that `README.md` and `README.zh.md` already reference.

Pass an alternate directory as `$1` to write elsewhere. `CHROME` and `PORT` env vars override the browser path and http.server port.

The script:
- Spins up a temporary `python3 -m http.server` on `127.0.0.1` (needed so Google Fonts CDN loads reliably in Chrome headless)
- Runs Chrome headless twice at `--force-device-scale-factor=2 --window-size=1536,580`
- Writes two 3072×1160 PNGs (~600 KB each)
- Tears down the server

### 5. Verify by eye — mandatory, do not skip

After rendering, **open each PNG and visually check every item** in this list. Do not report the diagram as done without going through it.

- [ ] Top-row card count matches the Default Services list you extracted in §1, every name rendered in full (no truncation on the longest, e.g. `ctx.systemPrompt` / `ctx.agentLoop`)
- [ ] Bottom-row card count matches the Capability Services list you extracted in §1, every name in full (especially the longest, e.g. `ctx.sessionPersistence`)
- [ ] Every card has a description underneath, and the description matches what the code does (not made up)
- [ ] Bar reads `Cordis · microkernel (vendored)` (EN) / `Cordis · 微内核 (vendored)` (ZH)
- [ ] Number of vertical connector lines equals (top-row cards + bottom-row cards) from §1. All straight vertical, all parallel, each reaching the horizontal center of its card
- [ ] `cordis.yml` sidebar visible on the right; dashed arrow points left into the bar
- [ ] `deployment leaf` / `部署清单` and `picks which plugins load` / `决定哪些插件加载` are readable and NOT crossed through by any connector line
- [ ] Chinese descriptions render as CJK glyphs, not `□` tofu boxes (means fonts loaded)
- [ ] No large empty gradient area at the bottom of the image — if there is, tune `--window-size` in `render.sh`

If any check fails: fix the CSS or template, re-run `render.sh`, re-check. Do not report "done" on first render without visually confirming.

---

## Design system (locked — do not modify without explicit user request)

Colors:
- Background: `linear-gradient(135deg, #ffffff 0%, #e8effc 100%)`
- Brand blue (Cordis bar + connectors): `#4a6ef5`
- Ink text: `#1a1a1a`
- Muted text: `#8a8f9c`
- Card border: `#dde3ef`
- Card fill: `#ffffff`

Typography (**sans-serif only** — never serif, never italic):
- English title & body: **Inter** (Google Fonts)
- Chinese title & body: **Noto Sans SC** (Google Fonts) with `PingFang SC` local fallback
- Code labels (`ctx.*`, `cordis.yml`, `vendored`): **JetBrains Mono** (Google Fonts)

Layout:
- `.page` max-width 1560 px, centered
- `.bus-row`, `.row.top`, `.row.bottom` all 96% width, centered
- Top row: `flex: 1` on each card (equal widths)
- Bottom row: `justify-content: space-between` + `flex: 0 0 auto` on each card — cards keep their intrinsic (nowrap) width and adjacent card backgrounds cannot clip a description
- Bus: `#4a6ef5` filled, 60 px tall, 8 px radius
- `cordis.yml` sidebar `position: absolute` at `left: calc(100% + 20px)` of `.bus-row`, width 130 px
- All connectors: CSS `::before` / `::after` pseudo-elements, 2 px wide, 40 px tall, `#4a6ef5`, centered via `left: 50%; transform: translateX(-50%)` — this is what guarantees pixel-perfect vertical parallel lines regardless of card content

Rendering:
- Chrome headless `--force-device-scale-factor=2`
- `--window-size=1820,580` → output is 3640×1160 (aspect ~3.14:1, wider than square-ish so a 12-card capability row fits without truncation)
- Local http.server on `127.0.0.1` so CDN fonts load cleanly

---

## Files in this skill

- `SKILL.md` — this file
- `harness-arch.css` — shared design system (colors, fonts, layout, connectors)
- `harness-arch-en.html` — English template
- `harness-arch-zh.html` — Chinese template
- `render.sh` — Chrome headless renderer

Templates are self-contained. Fonts load from Google Fonts CDN; no local font files.

---

## Rules I keep breaking (and shouldn't)

1. **Verify the output by looking at it.** Don't report "done" and move on — actually inspect each PNG and check every item in §5.
2. **Ground service descriptions in the code, not the docs' abstract, not the marketing copy.** If unsure what a package does, read its `src/` or the `ctx.<name>.register()` block.
3. **Don't touch layout unless asked.** 96% row/bar width, 40 px connector height, and 60 px bar height are all tuned. Card counts grow one at a time; once the bottom row starts to visibly overflow again (adjacent card backgrounds clipping a description, or the `cordis.yml` sidebar falling outside the render viewport), stop and ask before shrinking fonts, widening the viewport further, or wrapping to two rows.
4. **Never introduce a serif font or italic.** Not for titles, not for annotations, not "to make it feel editorial." This diagram is DeepSeek brand: sans-serif, upright, only.
