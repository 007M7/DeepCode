# qa-overlap-fix — payload-controls overlap regression probe

Guards the 2026-07-18 P0 fix (da779ac, merged as 9743db1): the
`.payload-controls` cluster (pretty ⇅ raw · copy · download) no longer
overlaps its label/meta text. Test-layer defense-in-depth is in
`test/style-css-static.test.js` under "payload-controls overlap lock";
this probe adds the runtime dimension (real Electron, real DOM, real
`getBoundingClientRect()`).

## Run

```
pnpm exec node scripts/qa-overlap-fix-probe.mjs [outDir]
```

The probe boots a fresh isolated Electron (private `--user-data-dir`,
dedicated `--remote-debugging-port=9247`), so it does NOT collide with
any `pnpm start` you already have open. It kills the child on exit.
Screenshots and a JSON geom trace land in `docs/qa-overlap-fix/`.

Exit codes: `0` = both widths overlap-free, `1` = overlap detected,
`2` = probe hit an internal error (e.g. CDP didn't come up).

Widths tested: **1440px** (broad) and **800px** (narrow — flex-wrap
kicks in; probe knows to allow that case).

## Running inside a worktree — electron symlink note

When you launch this probe from a worktree that has never had
`pnpm install` run in it, `node_modules/.bin/electron` won't exist and
the probe will fail with `ENOENT`. Two options:

1. `pnpm install` inside the worktree (safe, but downloads a fresh copy
   of electron per worktree — wastes disk).
2. **Symlink shortcut** — reuse the primary checkout's `node_modules`:

   ```sh
   ln -s ../../dsh-desktop-demo/node_modules node_modules
   ```

   (Path is relative to the worktree root; adjust `../../` for your
   layout.) The electron binary is content-addressed inside pnpm's
   store so the two checkouts share bytes.

Third pattern: run the probe directly from the primary checkout
(`cd ~/harness/dsh-desktop-demo && node scripts/qa-overlap-fix-probe.mjs`)
after cherry-picking the fix to test into that checkout. This is what
lane-overlap-fix used in the pre-compaction session and it works fine.

Also relevant for other lanes doing worktree-driven CDP probes: pnpm's
symlink layout is worktree-agnostic once you've bridged `node_modules`
in, so any script under `scripts/qa-*.mjs` that uses
`node_modules/.bin/electron` gets the same shortcut for free.

## What this covers

Four `attachPayloadControls` mount points get exercised implicitly:

- (A) tool-block **args** row — `renderer.js:1226` → `.tool-block-label-row`
- (B) tool-block **result** row — `renderer.js:1249` → `.tool-block-label-row`
- (C) tool-json-drawer sections — `tool-cards.js:663` →
  `.tool-json-section-controls[data-drawer-controls]`
- (D) trace-detail-pane Render=JSON — `trace-detail-pane.js:1512` →
  `.trace-detail-json-panel` (verified in the static gate; no runtime
  probe needed because that mount is `display: flex; flex-direction:
  column;` and the controls right-anchor via `margin-left: auto` — no
  same-line overlap topology exists there).

The static gate in `test/style-css-static.test.js` covers all four in
one CSS scan (any rule ending in `.payload-controls`,
`.tool-block-label-row`, or `.tool-json-section-controls` is banned
from `float: right|left` and negative `margin-top`, and the rules must
stay `display: flex`).
