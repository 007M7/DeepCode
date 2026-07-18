// Bug D layer 4 gate (2026-07-18) — every call site of
// `openForkCompare` in this codebase must be reachable only from a real
// user gesture. Because the guard lives *inside* openForkCompare itself,
// this test's job is to lock the guard's presence + validate no new call
// path bypasses the exported API.
//
// A new fork-compare open must be reached through the exported entry
// (window.__dshForkCompare.openForkCompare or the CommonJS `openForkCompare`
// name) — direct DOM manipulation like `fork-compare-drawer.hidden = false`
// would sidestep the guard. This test scans the whole `src/renderer/`
// tree for such bypasses and fails if any appear outside the owning
// module.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer')

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

test('fork-compare.js: openForkCompare has boot-quiet + gesture guards', () => {
  const src = fs.readFileSync(path.join(RENDERER_DIR, 'fork-compare.js'), 'utf8')
  assert.match(src, /BOOT_QUIET_MS/,
    'fork-compare.js must define a boot-quiet window')
  assert.match(src, /GESTURE_WINDOW_MS/,
    'fork-compare.js must define a gesture window')
  assert.match(src, /lastUserGestureAt/,
    'fork-compare.js must track lastUserGestureAt')
  // The guards must be reached inside openForkCompare, not just declared.
  const funcIdx = src.indexOf('function openForkCompare(opts)')
  assert.ok(funcIdx > 0)
  const body = src.slice(funcIdx, funcIdx + 3000)
  assert.match(body, /bootAgeMs\s*<\s*BOOT_QUIET_MS/,
    'openForkCompare must gate on bootAgeMs < BOOT_QUIET_MS')
  assert.match(body, /gestureAgeMs\s*>\s*GESTURE_WINDOW_MS/,
    'openForkCompare must gate on gestureAgeMs > GESTURE_WINDOW_MS')
})

test('no bypass: nothing under src/renderer/ toggles #fork-compare-drawer .hidden directly', () => {
  const files = walk(RENDERER_DIR, [])
  const bad = []
  for (const f of files) {
    // The owning module (fork-compare.js) is exempt — it OWNS the drawer.
    if (f.endsWith(path.sep + 'fork-compare.js')) continue
    const src = fs.readFileSync(f, 'utf8')
    // Match: `getElementById('fork-compare-drawer')` + a `.hidden = false`
    // within the next 200 chars. That's the shape a bypass would take.
    const rx = /getElementById\(['"]fork-compare-drawer['"]\)[\s\S]{0,200}\.hidden\s*=\s*false/
    if (rx.test(src)) bad.push(path.relative(RENDERER_DIR, f))
    // Also catch the switchTo cleanup — it sets `.hidden = true` which is
    // fine. Setting `.hidden = false` (unhiding) outside the owner is not.
  }
  assert.deepEqual(bad, [],
    'files that unhide #fork-compare-drawer directly bypass the gesture guard: ' + bad.join(', '))
})
