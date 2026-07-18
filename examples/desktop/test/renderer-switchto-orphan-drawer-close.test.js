// Bug D layer 5 (2026-07-18) — static test that switchTo cleans up the
// three orphan drawers documented in layout-overlap-audit.md.
//
// The audit found three drawers that historically stayed open across
// tab switches:
//   - .fork-compare-drawer     (#168 side-by-side compare)
//   - .playground-compare-drawer (playground compare)
//   - .devtools-drawer         (Devtools event log)
//
// Team-lead's directive: navigating implicitly dismisses. This test locks
// the guard in renderer.js by pattern-matching the switchTo prologue so
// the branch can't silently regress.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
  'utf8',
)

test('switchTo closes fork-compare drawer', () => {
  const idx = SRC.indexOf('function switchTo(name)')
  assert.ok(idx > 0, 'switchTo function must exist in renderer.js')
  const body = SRC.slice(idx, idx + 3000)
  assert.match(body, /window\.__dshForkCompare[\s\S]*closeForkCompare/,
    'switchTo must delegate to window.__dshForkCompare.closeForkCompare')
})

test('switchTo hides playground-compare-drawer element', () => {
  const idx = SRC.indexOf('function switchTo(name)')
  const body = SRC.slice(idx, idx + 3000)
  assert.match(body, /getElementById\(['"]playground-compare-drawer['"]\)/,
    'switchTo must find and hide the playground-compare-drawer element')
  // The line right after must set hidden = true.
  assert.match(body, /playground-compare-drawer[\s\S]{0,120}hidden\s*=\s*true/,
    'switchTo must set the playground-compare-drawer .hidden = true')
})

test('switchTo hides every .devtools-drawer', () => {
  const idx = SRC.indexOf('function switchTo(name)')
  const body = SRC.slice(idx, idx + 3000)
  assert.match(body, /querySelectorAll\(['"]\.devtools-drawer['"]\)/,
    'switchTo must querySelectorAll .devtools-drawer')
  assert.match(body, /devtools-drawer[\s\S]{0,200}hidden\s*=\s*true/,
    'switchTo must hide every .devtools-drawer')
})

test('switchTo cleanup is defensive (try/catch around drawer hiding)', () => {
  const idx = SRC.indexOf('function switchTo(name)')
  const body = SRC.slice(idx, idx + 3000)
  // The cleanup block should be try-wrapped so a stray null.dashN or
  // missing __dshForkCompare export in a stripped build never breaks tab
  // navigation. Presence of `try {` + `catch` inside the first 3 KB of
  // the switchTo body proves this.
  assert.match(body, /try\s*\{[\s\S]{0,1500}closeForkCompare[\s\S]{0,1500}catch/,
    'the drawer-cleanup block must be try/catch guarded')
})
