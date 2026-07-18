# Structure Phase 1 — Fresh-boot QA verification

Cold-start of `DSH_QA=1 electron .` on branch `fix/structure-phase1`
(commits `c093bba` F-05 mock 迁出 + `04cec5f` F-14 注释瘦身). Purpose:
confirm the 23 mock functions migrated to `src/renderer/mock-fixtures.js`
still resolve by name in a real Electron boot and still render their
cards through the same dispatch path.

Re-verified post-merge on `78d0175` after syncing `test-real@9743db1`
(ui-hotfix A+B + oss-clean/oss-prep/fresh-eyes batches).

## CDP-driven assertions

Each ran against a fresh Electron page via `scripts/qa-cdp-drive.mjs`:

1. `typeof mockApproval === 'function'` → `true`
2. `typeof mockCardDiff === 'function' && typeof loadWorkflowFixture === 'function' && typeof mountBatch3Card === 'function'` → `true`
3. Click `#mock-card-diff` → stream gained a `.tool-row / [class*=diff]` row (`hasDiff: true`).
4. Click `#mock-workflow-seq` → `context-rail-drawer.hidden = false`, `.context-rail-batch3-mount` present, mount text contains all of `workflow`, `seq`, `translate-comments`.

## Screenshots

- `fresh-boot-workflow-fixture.png` — original pre-merge run on `04cec5f`.
- `fresh-boot-post-merge.png` — post-merge run on `78d0175` (after ui-hotfix
  drawer-close rebind + payload-controls fix landed via test-real).

Both show the mock-workflow-seq drawer expanded with the seq run
(`workflow · seq · translate-comments` header, `read types.ts / extract
comment blocks / translate to zh …` step rows). No ReferenceError in
`/tmp/lane-structure-electron.log`; the Debug popover's binding code in
renderer.js resolved every function name on first paint.

## Static gates (post-merge)

- `node --check src/renderer/renderer.js` — pass
- `node --check src/renderer/mock-fixtures.js` — pass
- `node --test test/renderer-collisions.test.js` — 4/4 pass (mock-fixtures.js in NON_IIFE_ALLOWLIST)
- `node --test test/*.test.js` — 1508/1508 pass (matches test-real@9743db1 baseline exactly; no test-count delta from this branch, the 1523 count reported pre-merge was under the pre-oss-clean tree that has since been slimmed on test-real)

## Line accounting

- pre-merge renderer.js: `04cec5f` → 7247 lines (F-05 −579 + F-14 −17 vs 7843 baseline)
- post-merge renderer.js: `78d0175` → 7294 lines (+47 from inbound test-real edits above and below the mock/comment regions)
- mock-fixtures.js: 610 lines (unchanged)
