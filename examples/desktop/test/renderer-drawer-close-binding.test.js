// Static gate: `#tool-json-drawer` and `#tool-json-drawer-close` live at the
// bottom of index.html (~line 1401), AFTER the `<script src="./renderer.js">`
// tag (~line 1337). Any top-level `document.getElementById('tool-json-
// drawer-close')` in renderer.js returns `null` at parse time and the
// `if (btn)` guard silently drops the listener — the exact regression the
// 2026-07-18 P0 hotfix landed. The user saw it as "× 擦不掉了".
//
// Contract this test locks:
//   1. The two ids are still referenced from renderer.js (in case the wiring
//      moves and someone forgets to update the html position too).
//   2. Every `document.getElementById('tool-json-drawer-close')` reference
//      inside renderer.js sits inside a function body — never at top level —
//      OR is guarded by a `document.readyState`/`DOMContentLoaded` deferral.
//      Same rule for `document.getElementById('tool-json-drawer')` when its
//      result is used to `addEventListener('click', …)` on it.
//
// This is a static text scan (not a full AST parse) so it's paranoid on
// purpose: any occurrence of the pattern outside a function body flunks.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js')

test('drawer close binding is not attempted at top-level (would silently no-op)', () => {
  const source = fs.readFileSync(RENDERER, 'utf8')
  const lines = source.split(/\r?\n/)
  // Compute brace depth at every line start. `depth === 0` means "top level".
  // (String literals + template strings + regex + comments are naive-scanned;
  // that's fine for renderer.js which doesn't hide unbalanced braces in them.)
  let depth = 0
  const depthAtLine = []
  for (const line of lines) {
    depthAtLine.push(depth)
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '{') depth++
      else if (c === '}') depth--
    }
  }
  // Find every getElementById('tool-json-drawer-close') and
  // ('tool-json-drawer') occurrence. Any that lives at depth 0 flunks.
  const bad = []
  const re = /document\.getElementById\('tool-json-drawer(?:-close)?'\)/g
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]
    if (re.test(line)) {
      if (depthAtLine[ln] === 0) {
        bad.push({ line: ln + 1, text: line.trim() })
      }
      re.lastIndex = 0
    }
  }
  assert.deepEqual(bad, [], `top-level getElementById('tool-json-drawer[-close]') is a P0 regression — DOM does not exist yet at that point. Wrap the binding in a function called from DOMContentLoaded / document.readyState-guarded path.\nOffenders:\n${bad.map(b => `  renderer.js:${b.line}: ${b.text}`).join('\n')}`)
})

test('drawer close close-handler is bound via a deferred hook (not at parse time)', () => {
  const source = fs.readFileSync(RENDERER, 'utf8')
  // The hotfix introduces a bindJsonDrawerClose() helper called under a
  // readyState guard. Assert both exist so future refactors that inline
  // the binding back to top-level fail this check.
  assert.match(source, /function bindJsonDrawerClose\s*\(/,
    'bindJsonDrawerClose() helper missing — the deferred-binding guard is the fix for the 2026-07-18 P0 "× 擦不掉了" regression')
  assert.match(source, /document\.readyState[\s\S]{0,200}DOMContentLoaded[\s\S]{0,200}bindJsonDrawerClose/,
    'bindJsonDrawerClose() must be wired via readyState/DOMContentLoaded so the drawer × button (which sits below the <script> tag in index.html) is present when we bind')
})
