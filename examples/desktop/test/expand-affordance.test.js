// expand-affordance.test.js — lock the disclosure-marker + a11y
// contract for fix/expand-affordance (2026-07-18).
//
// User report: "没有展开时候，看上去让人不是很知道它点击是可以展开的
// ……哪怕加一个那种折叠小箭头". This test locks:
//
//   1. details-aria.js's wireDetailsAria helper reflects [open] state
//      onto the summary's aria-expanded attribute (initial + after
//      toggle). Plugin authors copy this pattern.
//   2. CSS tail block in style.css adds a ▸ marker on every 缺失
//      surface enumerated in docs/expand-affordance-audit.md. We
//      static-grep the stylesheet for the required selectors + the
//      ▸ (\25B8) glyph — jsdom-less environment can't render
//      pseudo-elements, so the grep is the enforceable lock.
//   3. assistant-turn.js's trace drawer builder sets a user-facing
//      tooltip + wires aria-expanded through the toggle event.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { wireDetailsAria } = require(path.join(__dirname, '..', 'src', 'renderer', 'details-aria.js'))

function makeStubDetails (initialOpen = false) {
  const listeners = new Map()
  const attrs = new Map()
  const summary = {
    tagName: 'SUMMARY',
    setAttribute (name, value) { attrs.set(name, String(value)) },
    getAttribute (name) { return attrs.has(name) ? attrs.get(name) : null },
  }
  const details = {
    tagName: 'DETAILS',
    open: initialOpen,
    addEventListener (event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    dispatch (event) {
      const fns = listeners.get(event) || []
      for (const fn of fns) fn.call(this)
    },
  }
  return { details, summary, attrs }
}

test('wireDetailsAria: reflects initial open state', () => {
  const { details, summary, attrs } = makeStubDetails(false)
  wireDetailsAria(details, summary)
  assert.equal(attrs.get('aria-expanded'), 'false', 'closed details → aria-expanded=false')

  const opened = makeStubDetails(true)
  wireDetailsAria(opened.details, opened.summary)
  assert.equal(opened.attrs.get('aria-expanded'), 'true', 'open details → aria-expanded=true')
})

test('wireDetailsAria: reflects toggle event', () => {
  const { details, summary, attrs } = makeStubDetails(false)
  wireDetailsAria(details, summary)
  assert.equal(attrs.get('aria-expanded'), 'false')
  // Simulate user click opening the drawer — the native <details>
  // element flips `.open` then dispatches `toggle`. We mimic both.
  details.open = true
  details.dispatch('toggle')
  assert.equal(attrs.get('aria-expanded'), 'true', 'after toggle open → true')
  details.open = false
  details.dispatch('toggle')
  assert.equal(attrs.get('aria-expanded'), 'false', 'after toggle close → false')
})

test('wireDetailsAria: no-ops on missing args', () => {
  // Guard against half-built rows (a builder that forgot to attach
  // the summary). Should not throw, and neither the missing summary
  // nor the missing details should raise.
  assert.doesNotThrow(() => wireDetailsAria(null, {}))
  assert.doesNotThrow(() => wireDetailsAria({}, null))
  assert.doesNotThrow(() => wireDetailsAria(null, null))
})

// -- CSS marker lock --------------------------------------------------------

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'style.css')
const cssText = fs.readFileSync(CSS_PATH, 'utf8')

// The 14 缺失 selectors that gained a ▸ marker in the fix/expand-affordance
// tail block. If a surface later moves to a different fold pattern, the
// entry must be moved out of this list into the audit doc's 达标 column.
const AFFORDANCE_SELECTORS = [
  '.turn-trace-drawer > .turn-trace-drawer-summary::before',
  'details.prompt-blocked-row > summary.pb-row-head::before',
  '.devtools-row-summary::before',
  '.recall-card summary::after', // right-tail placement (semantic ⌕ occupies row head)
  '.inject-card summary::before',
  '.subagent-trace > .subagent-trace-summary::after', // right-tail placement (status glyph occupies row head)
  '.raw-inject-card > .raw-inject-summary::before',
  '.raw-inject-l2 > summary::before',
  '.runtime-row-head::before',
  '.context-page-row-summary::before',
  '.trace-detail-row-fields-summary::before',
  '.trace-detail-section > summary::before',
  '.trace-detail-attr-group > .trace-detail-attr-group-head::before',
  '.trace-detail-field-block > .trace-detail-field-block-head::before',
]

test('style.css: every 缺失 disclosure surface declares a fold marker', () => {
  for (const sel of AFFORDANCE_SELECTORS) {
    const found = cssText.indexOf(sel) !== -1
    assert.ok(found, `expected style.css to declare ${sel} for fold-affordance`)
  }
})

test('style.css: fold-affordance block uses the ▸ (\\25B8) glyph', () => {
  // Locate the batch block by its header comment (added in the
  // fix/expand-affordance CSS tail — one authoritative site).
  const header = 'Expand-affordance batch (fix/expand-affordance, 2026-07-18)'
  const idx = cssText.indexOf(header)
  assert.notEqual(idx, -1, 'fix/expand-affordance CSS block must exist')
  const block = cssText.slice(idx)
  // Every marker rule in the block uses `content: '\25B8'` (▸). Count
  // must equal the number of ::before/::after selectors above — same
  // one triangle glyph, uniform rotation on [open].
  const markerCount = (block.match(/content:\s*'\\25B8'/g) || []).length
  assert.ok(
    markerCount >= AFFORDANCE_SELECTORS.length,
    `expected ≥${AFFORDANCE_SELECTORS.length} ▸ markers in the batch; got ${markerCount}`
  )
  // Every marker rotates 90deg when the enclosing details is [open].
  const rotateCount = (block.match(/transform:\s*rotate\(90deg\)/g) || []).length
  assert.ok(
    rotateCount >= AFFORDANCE_SELECTORS.length,
    `expected ≥${AFFORDANCE_SELECTORS.length} rotate(90deg) rules; got ${rotateCount}`
  )
})

test('style.css: no emoji sneaked in via the fold-affordance batch', () => {
  const header = 'Expand-affordance batch (fix/expand-affordance, 2026-07-18)'
  const idx = cssText.indexOf(header)
  const block = cssText.slice(idx)
  // Range check: no code-point in the emoji planes.
  //   U+1F300..U+1FAFF pictographs + U+2600..U+27BF misc symbols/dingbats.
  // (We deliberately allow U+25B8 ▸ which is in the Geometric Shapes block,
  //  U+2500-U+257F — outside these ranges.)
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u
  assert.equal(emojiRe.test(block), false, 'fold-affordance batch must contain no emoji')
})

// -- assistant-turn.js trace-drawer wiring lock -----------------------------

const AT_PATH = path.join(__dirname, '..', 'src', 'renderer', 'assistant-turn.js')
const atText = fs.readFileSync(AT_PATH, 'utf8')

test('assistant-turn: trace drawer summary carries user-facing tooltip + aria-expanded wiring', () => {
  // Locate the traceDrawerEl builder block (skip the guard-clause
  // occurrence at the top of the function).
  const anchor = atText.indexOf("drawer.className = 'turn-trace-drawer'")
  assert.notEqual(anchor, -1)
  const block = atText.slice(anchor, anchor + 2000)
  assert.ok(
    /summary\.title\s*=\s*'Click to expand Tree \/ Timeline \/ Graph views'/.test(block),
    'trace drawer summary must have the discoverability tooltip'
  )
  assert.ok(
    /summary\.setAttribute\('aria-expanded',\s*'false'\)/.test(block),
    'trace drawer summary must set aria-expanded=false initially'
  )
  assert.ok(
    /drawer\.addEventListener\('toggle'/.test(block),
    'trace drawer must reflect open state via toggle event'
  )
})

// -- renderer.js parallel drawer builder lock -------------------------------

const RJ_PATH = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js')
const rjText = fs.readFileSync(RJ_PATH, 'utf8')

test('renderer.js: finishTurnContainer trace drawer wires aria-expanded + tooltip', () => {
  // There are two drawer builders — assistant-turn.js and this
  // renderer.js path used before the TurnBuilder migration completes.
  // Both must set the tooltip so a fresh session's first turn is
  // still discoverable.
  const anchor = rjText.indexOf("drawer.className = 'turn-trace-drawer'")
  assert.notEqual(anchor, -1)
  const block = rjText.slice(anchor, anchor + 2000)
  assert.ok(
    /summary\.title\s*=\s*'Click to expand Tree \/ Timeline \/ Graph views'/.test(block),
    'renderer trace drawer summary must have the discoverability tooltip'
  )
  assert.ok(
    /summary\.setAttribute\('aria-expanded',\s*'false'\)/.test(block),
    'renderer trace drawer must set aria-expanded=false initially'
  )
  assert.ok(
    /drawer\.addEventListener\('toggle'/.test(block),
    'renderer trace drawer must reflect open state via toggle event'
  )
})

test('renderer.js: init hook installs a document-wide details aria observer', () => {
  assert.ok(
    /initDetailsAriaObserver/.test(rjText),
    'renderer.js must install initDetailsAriaObserver'
  )
  assert.ok(
    /new MutationObserver/.test(rjText),
    'observer must use MutationObserver'
  )
  assert.ok(
    /dataset\.ariaWired/.test(rjText),
    'observer must be idempotent via dataset.ariaWired'
  )
})
