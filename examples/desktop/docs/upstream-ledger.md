# Upstream ledger

Findings that need a fix in `deepseek-harness` upstream (not in this repo),
kept here so we don't lose them when we ship the desktop demo. Each entry is
a promise to file — either an RFC (via `docs/upstream-rfc-pack/`) or a
narrower PR. What lives in this repo is the local workaround; what lives
upstream is the proper fix.

Format per entry:

- **Symptom** — what a user sees today.
- **Root cause** — file:line pins into the upstream repo (path relative to
  `packages/…` in `deepseek-harness-dev/` or the corresponding org path in
  `deepseek-ai/deepseek-harness`).
- **Local workaround** — what we did in this repo to keep the demo honest,
  and how to spot the workaround at review time.
- **Upstream fix (needed)** — the shape of the correct change.

---

## L-1  Runtime should emit the presented view for tool results, not the raw `execute()` meta

**Symptom.** On the default profile (`stdio-deepseek`), the file-diff card
never renders after an `fs.edit` / `fs.write`. The tool executes, the result
box appears, but the visual diff (which is the headline for the "files
visualization" story) is missing. Same latent risk for the terminal card on
`bash`.

**Root cause.** Two layers in upstream never meet:

- `packages/fs/tool-fs/src/edit.ts:92-96` — `execute()` returns
  `{ content, meta: { diffs } }`. There is no `card` field on this meta.
- `packages/fs/tool-fs/src/edit.ts:111-116` — `presentResult()` is where
  the display view (`{ card: 'diff', title, diffs }`) is authored. This is a
  display-time callback.
- `packages/core/agent-loop/src/loop.ts:584-594` — the runtime persists the
  raw `execute()` meta verbatim on the `tool/result` event. `presentResult()`
  is never invoked; nothing on the wire ever gains a `card` discriminant.
- `packages/core/tools/src/index.ts:787-790` — the tool-registry side of the
  same seam; `presentResult()` is declared in the tool descriptor but has
  no runtime call site.

The desktop renderer's `tool/result` dispatch (this repo's
`src/renderer/renderer.js:4744`) primarily routes by `view.card === 'diff' |
'terminal' | 'widget'`. With no `card` on the wire, all fs meta falls
through to the raw-text fallback branch.

**Local workaround.** `src/renderer/renderer.js:4744` now has a fs-family
fallback: when `view.card` is absent, `view.diffs` is an array, and the
tool name is fs-family (`fs.edit` / `fs.write` / `fs.read`, or the
short-form aliases), it synthesises `{ card: 'diff', title, diffs }` and
renders through the same path. See test/`renderer-diff-card-fallback.test.js`
+ `test/fixtures/fs-edit-wire-shape.json` (the fixture is the real wire
shape captured on lane-showcase 2026-07-18 during the 12/12 verify).

Spot the workaround in code review by the `viewLooksLikeDiff` /
`isFsFamilyTool` locals in the `tool/result` case, and by the fixture
JSON's `_note` header.

**Upstream fix (needed).** Either

- Make `agent-loop` invoke `presentResult(args, result)` on `tool/result`
  emit and put the returned view onto the wire under `data.meta`, replacing
  (or supplementing) the raw `execute()` meta; OR
- Expose the tool registry to the shell so a shell-side dispatcher can call
  `presentResult` after receiving the raw meta.

Either shape is a small RFC (see `docs/upstream-rfc-pack/` template). The
tool-side contract (`presentResult` returning `ToolResultView`) already
exists — this is a wiring gap, not a design decision.

Once upstream lands the fix, the fallback becomes dead code but stays in
place (the shape test still passes via the primary `card:'diff'` branch),
so there's no coupling between land order.

---

<!--
  Future entries append below. Keep the numbering monotone (L-2, L-3…) so a
  cross-repo reference like "see upstream ledger L-1" stays stable.
-->
