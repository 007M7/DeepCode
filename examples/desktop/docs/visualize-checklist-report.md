# Visualize checklist report — fix/default-profile-showcase

**Branch**: `fix/default-profile-showcase`
**Latest verification run**: default profile `stdio-deepseek`, real DeepSeek API, 2 turns / 1 session, 2026-07-18 18:42 UTC.
**Script**: `scripts/showcase-12x12-verify.mjs` (internal QA driver, kept out of the released tree — hardcoded absolute paths).
**Raw evidence**: `/tmp/dsh-showcase/result.json` + `replay.log` (audit trail).

## What lands in this branch

Four commits, each with a test lock:

1. **Config (`config/deepseek-jsonrpc.yml`)** — pin `thinking: enabled` on `llm-deepseek` and add the full `fs-local` + `fs-policy` + `tool-fs` stack so the model actually sees `fs.edit`. Test: `test/deepseek-jsonrpc-showcase.test.js`.
2. **Renderer fallback (`src/renderer/renderer.js`)** — minimal, family-scoped: when a `tool/result`'s `meta` lacks a `card` field but has a `diffs` array AND the tool name is fs family (`fs.edit` / `fs.write` / `fs.read` or the short-form aliases), synthesize `{ card: 'diff', title, diffs }` and route through the existing diff-card renderer. Test: `test/renderer-diff-card-fallback.test.js` + `test/fixtures/fs-edit-wire-shape.json` (the real wire shape captured on this run — the shape lock protects against upstream shape drift AND against the fallback regressing).
3. **Upstream ledger (`docs/upstream-ledger.md`)** — the `presentResult` wiring gap written up with `file:line` pins, so the follow-up upstream PR has an evidence starting point.
4. **This report + screenshots** — twelve verdicts, all with DOM-selector evidence and screenshot references.

The renderer change is deliberately narrow: it does NOT touch the `presentResult` call site, does NOT introduce a tool registry to the shell, and becomes dead code the moment the runtime seam emits a proper `card: 'diff'` view. The shape test still passes via the primary branch after that lands, so there is no coupling between land order.

## 12/12 verdict table

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | user bubble | PASS | `.msg .role-label` matches present in both turns of the stream. |
| 2 | assistant stream | PASS | `.msg.assistant` present with visible non-fork text — turn 1 emits the calculation body, turn 2 replies briefly. |
| 3 | reasoning fold | PASS | 6 `.reasoning-block` elements rendered across the two turns (thinking mode active — the config change pins `thinking: enabled`). |
| 4 | tool call row + args | PASS | 4 `.tool-block` rows across the two turns (bash + fs.read + fs.edit + supporting call); `{ }` brace-button clicks reveal args. |
| 5 | diff card (family=fs) | **PASS** | 1 `.card-diff` element rendered after fs.edit; wire meta `{diffs:[...]}` (no `card` field on the wire) was routed through the fs-family fallback described in the "What lands" section. |
| 6 | terminal card (bash) | PASS | bash `.tool-block.family-bash` present; card body carries command text + captured stdout. |
| 7 | turn footer with real values | PASS | Footer text > 5 chars, no all-dash string. Shows real usage/duration numbers. |
| 8 | trace row + tri-view | PASS | `.trace-card` present, all three tri-chips (`tree`/`timeline`/`graph`) toggle their panels to visible. |
| 9 | JSON drawer payload | PASS | `{ }` badge opens a drawer or reveals the inline `<pre>` containing the full args JSON. |
| 10 | Tracing page row | PASS | `#tracing-page-tbody tr` count = 1; the row matches this session's id and its cells are populated (not all-dash). |
| 11 | step boundary chips | PASS | `.trace-step-chips` / `.trace-step-meta` present in the stream. |
| 12 | context meter numeric | PASS | Meter title carries a real numeric token count against the assumed-window fallback. |

**12/12 pass.**

Screenshots:

- Chat view after both turns: [`chat.png`](visualize-checklist-shots/chat.png)
- Tracing page: [`tracing.png`](visualize-checklist-shots/tracing.png)

## What the config change does

Two edits to `config/deepseek-jsonrpc.yml`:

1. **Pinned `thinking: enabled` on the `llm-deepseek` entry.** The provider default is already `enabled` today, so this is a pin, not a semantic change. It guarantees that a future flip in the upstream default won't silently drop the reasoning-delta stream on the default profile (which would take the fold visualization with it).
2. **Added the full model-facing filesystem stack**: `fs-local` (backend) + `fs-policy` (read-before-write contract) + `tool-fs` (model-facing fs.read/edit/write). The user's brief asked for `fs-local` alone (matching `deepseek-vibe.yml`), but the model needs `tool-fs` to actually see `fs.edit` in its tool list — without it the model literally replies "no fs tool available", which is what happened on the first verification pass. All three pieces are copy-mirrored from `examples/coding-agent/cordis.yml`, the canonical composition.

Test lock: `test/deepseek-jsonrpc-showcase.test.js` asserts both fields in the same static-text style as the existing `deepseek-config-workspace-context.test.js`.

## What the renderer fallback does

Same tool wires the same meta shape today whether it succeeds through `presentResult()` or not — the runtime persists the tool's raw `execute()` return verbatim (see the upstream ledger). For fs.edit that shape is `{ diffs: [...] }` with no `card` discriminant, and the primary dispatch at `src/renderer/renderer.js:4744` was routing it to the raw-text fallback branch.

The added branch is scoped strictly to (`!isError`) + (fs-family tool name) + (`view.diffs` array present) + (no `card` field). It rebuilds a synthetic `{ card: 'diff', title, diffs }` view and calls the same `renderDiffCard` the primary path uses, so the visual is identical to what a `presentResult`-emitting runtime would produce.

## Profile tool matrix (default vs. vibe)

Both profiles now share the same headline-visualization surface. The other tools differ (vibe carries web + tool-cordis on top).

| Profile | thinking | bash | fs backend | fs policy | fs tools | web | tool-cordis |
|---|---|---|---|---|---|---|---|
| stdio-deepseek (default) | enabled (pinned) | yes | fs-local | fs-policy | tool-fs | — | — |
| stdio-vibe-deepseek | provider-default | yes | fs-local | — | — | yes | yes |

## Upstream ledger reference

The `presentResult` wiring gap — root cause of the "diff card never renders without a shell-side workaround" symptom — is written up as ledger entry **L-1** in [`docs/upstream-ledger.md`](upstream-ledger.md), with file-line pins into `deepseek-harness`:

- `packages/fs/tool-fs/src/edit.ts:92-96` — `execute()` returns raw `{diffs}` meta.
- `packages/fs/tool-fs/src/edit.ts:111-116` — `presentResult()` authors `{card:'diff', ...}` but is never invoked.
- `packages/core/agent-loop/src/loop.ts:584-594` — the runtime persists `execute()` meta verbatim on the wire.
- `packages/core/tools/src/index.ts:787-790` — the tool-registry side of the same seam.

The upstream fix is a small RFC (either agent-loop invokes `presentResult` at emit time, or the shell gains access to the tool registry to invoke it on receipt). Either way, the fallback added here becomes dead code but the shape test keeps passing via the primary `card:'diff'` branch, so the two changes are independent.

## Isolation discipline followed

- CDP 9310 (not 9273/9299).
- `--user-data-dir=/tmp/dsh-showcase/userdata` + `DSH_DESKTOP_HOME=/tmp/dsh-showcase/dshhome`.
- `DSH_DEV_ROOT=$HOME/harness/deepseek-harness-dev`.
- `.onboarded` sentinel pre-seeded; modal-visibility recheck before touching `#new-session`.
- `DEEPSEEK_API_KEY` read from `~/harness/deepseek-harness-dev/.env`, never logged.
- `DSH_QA` explicitly unset.
- Child processes reclaimed on exit (SIGTERM then SIGKILL).
- No touch to `~/.dsh-desktop`, no touch to the user's Electron install.

## Cost

**2 real API turns** on the final green run (well under the ≤6 budget). Each turn was a full round-trip with tool calls; total wall time ≈ 15 s from prompt send to second `turn/end`.
