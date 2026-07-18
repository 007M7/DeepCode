// Fresh-eyes P0 fixes (2026-07-18, docs/review-fresh-eyes.md).
// Locks the four blind-walkthrough issues at their pure-module + static
// surfaces so a future refactor can't quietly regress them:
//
//   #1 New session — empty-welcome template survives streamEl clears
//      (verified by DOM presence + hidden marker template inspection).
//   #2 See a full trace — layout boot toast is silent (layout-controller
//      exposes applyBodyClass; assert silent path suppresses the toast).
//   #6 epoch-1969 timestamps — trace-detail-pane.formatTime returns '—' at
//      time <= 0 (matches tracing-index-model's own guard).
//   #7 Send button — style.css declares an explicit .composer-send:disabled
//      state so a first-run researcher sees why they can't send.
//   #4 Debug popover — CSS hides .debug-popover unless body[data-qa="1"].
//
// Pure module coverage; the runtime integration (renderer.js seams) is
// smoke-tested via the electron-e2e harness (out of scope here).

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// ---------- #6 formatTime guard ------------------------------------------

test('trace-detail-pane.formatTime returns em-dash for epoch-0', () => {
  const dp = require('../src/renderer/trace-detail-pane.js')
  assert.equal(dp.formatTime(0), '—', 'time=0 must not render as 1969')
  assert.equal(dp.formatTime(-1), '—', 'negative time must render as em-dash')
  // Preflight (2026-07-18): pre-Y2K positives (fixture-relative times like
  // sample-session.json's `time: 1000, 1050, …`) must also render em-dash.
  assert.equal(dp.formatTime(1), '—', 'ms=1 must render as em-dash')
  assert.equal(dp.formatTime(1000), '—', 'ms=1000 must render as em-dash')
  assert.equal(dp.formatTime(946684799999), '—', 'ms just before Y2K must render as em-dash')
})

test('trace-detail-pane.formatTime formats real timestamps', () => {
  const dp = require('../src/renderer/trace-detail-pane.js')
  const t = new Date('2026-07-18T12:00:00').getTime()
  const s = dp.formatTime(t)
  assert.match(s, /2026/, 'real ms must render human-readable local time')
})

test('trace-detail-pane.formatTime passes strings through, falsy others → empty', () => {
  const dp = require('../src/renderer/trace-detail-pane.js')
  assert.equal(dp.formatTime('2026-07-18T00:00:00Z'), '2026-07-18T00:00:00Z')
  assert.equal(dp.formatTime(undefined), '')
  assert.equal(dp.formatTime(null), '')
})

// ---------- #7 Send button disabled visual state -------------------------

test('style.css declares .composer-send:disabled with a visible fallback', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/style.css'), 'utf8')
  const idx = css.indexOf('.composer-send:disabled')
  assert.ok(idx >= 0, '.composer-send:disabled rule must exist')
  const block = css.slice(idx, idx + 400)
  assert.match(block, /background:\s*var\(--surface-hover\)/,
    'disabled send button must paint on --surface-hover so it stays legible')
  assert.match(block, /opacity:\s*1/,
    'disabled send button must NOT fade to the default button:disabled opacity 0.4')
})

// ---------- #4 Debug popover QA gate -------------------------------------

test('style.css hides .debug-popover unless body[data-qa="1"]', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/style.css'), 'utf8')
  // The gate is a single rule; grep for it verbatim.
  assert.match(css, /body:not\(\[data-qa="1"\]\)\s*\.debug-popover\s*\{\s*display:\s*none/,
    'Debug popover must be display:none in production (no data-qa flag)')
})

// ---------- #2 Layout boot toast silent path -----------------------------

test('layout-controller silent boot + changed-only toast paths are wired', () => {
  // No module export; assert the source contains the silent-boot idiom so a
  // careless "readable simplification" that drops the silent flag surfaces
  // in review. This is a low-cost tripwire, not a runtime assertion.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/layout-controller.js'), 'utf8')
  assert.match(src, /applyBodyClass\(['"]chat['"],\s*\{\s*silent:\s*true\s*\}\)/,
    'boot() must call applyBodyClass with silent:true so no boot-time toast fires')
  assert.match(src, /const\s+changed\s*=\s*next\s*!==\s*currentBodyClass/,
    'applyBodyClass must compute `changed` so the toast fires only on real layout swaps')
  assert.match(src, /if\s*\(!silent\s*&&\s*\(changed\s*\|\|\s*force\)\)/,
    'toast gate must be `!silent && (changed || force)` — session-switch replays must not toast')
  assert.match(src, /applyBodyClass\(hint,\s*\{\s*force:\s*true\s*\}\)/,
    'chooseLayout must pass force:true so user-driven picks keep the toast feedback')
})

// ---------- #1 Empty-welcome snapshot idiom is present ------------------

test('renderer.js snapshots the empty-welcome template at boot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/renderer.js'), 'utf8')
  assert.match(src, /emptyWelcomeTemplate\s*=/,
    'renderer must snapshot the empty-welcome template so New session can restore it')
  assert.match(src, /updateEmptyStateVisibility/,
    'renderer must expose updateEmptyStateVisibility so replay/selectSession/onInitialized can re-check')
})

test('renderer.js runtime-warning banner cleared on onInitialized', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/renderer.js'), 'utf8')
  // Rough positional check: `onInitialized` handler must remove any stale
  // chat-runtime-banner. Search within the handler window.
  const idx = src.indexOf('window.dsh.onInitialized((info)')
  assert.ok(idx >= 0)
  const window = src.slice(idx, idx + 2000)
  assert.match(window, /chat-runtime-banner/,
    'onInitialized handler must reference the runtime banner so it can dismiss stale ones on reconnect')
  assert.match(window, /staleBanner.*remove\(\)/s,
    'onInitialized must call remove() on the stale banner after reconnect')
})

// ---------- #6 subagent friendly name ------------------------------------

test('renderer.js exposes subagentPlaceholderTitle helper with parent-title lookup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/renderer.js'), 'utf8')
  assert.match(src, /function\s+subagentPlaceholderTitle\s*\(parentId\)/,
    'placeholder helper must exist so both subagent.started paths share it')
  assert.match(src, /subagentPlaceholderTitle\(parentId\)/,
    'live subagent.started handler must call the helper (not the raw hash slice)')
})
