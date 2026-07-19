// Static CSS assertions for fix/visual-consistency-polish.
//
// Guards the invariants that the review-visual-flow P0/P1 findings turn on:
//   - .rubric-hint-card is a compact row (no gradient, no 12px radius).
//   - .turn-signal-chip.sig-plan sits off the --accent axis so it doesn't
//     fuse with --turn-action-edge (which is bound to --accent).
//   - Rubric-grid pass/fail cells route through --ok / --err tokens, not
//     the raw hex family (#79d17b / #f96e6e) Lane D shipped with.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'style.css')
const CSS = fs.readFileSync(CSS_PATH, 'utf8')

function findBlock(selector) {
  // Escape regex metacharacters in the selector, then match the first
  // occurrence: `selector { ... }` up to the closing brace.
  const esc = selector.replace(/[-.[\]/{}()*+?^$|]/g, '\\$&')
  const re = new RegExp(esc + '\\s*\\{[^}]*\\}')
  const m = CSS.match(re)
  assert.ok(m, 'expected to find CSS block for ' + selector)
  return m[0]
}

test('rubric-hint-card is a compact row: no gradient, no 12px radius', () => {
  const block = findBlock('.rubric-hint-card')
  assert.ok(!/linear-gradient/.test(block),
    '.rubric-hint-card must not use linear-gradient (spec §2: L1 material not hero)')
  assert.ok(!/border-radius:\s*12px/.test(block),
    '.rubric-hint-card must not use 12px radius (spec §7 grid: 4/6/8)')
  assert.match(block, /border-radius:\s*4px/,
    '.rubric-hint-card should carry the compact-row 4px radius')
  assert.match(block, /background:\s*var\(--surface\)/,
    '.rubric-hint-card should tokenize its background')
})

test('plan-signal color tokens are declared and NOT on the --accent/blue axis', () => {
  // Tokens exist on :root
  assert.match(CSS, /--signal-plan-fg\s*:\s*#0f766e/,
    'light --signal-plan-fg should be the teal family, not blue')
  // Also declared for both dark blocks
  const darkBlocks = CSS.match(/--signal-plan-fg\s*:\s*#5eead4/g) || []
  assert.ok(darkBlocks.length >= 2,
    'dark --signal-plan-fg (#5eead4) should be declared for @media dark and [data-theme="dark"]')
})

test('plan signal chips route through the token, not the raw blue hex', () => {
  const planBlock = findBlock('.turn-signal-chip.sig-plan')
  assert.match(planBlock, /var\(--signal-plan-fg\)/,
    '.sig-plan color must reference --signal-plan-fg, not raw blue')
  assert.ok(!/#1d4ed8|#2563eb/.test(planBlock),
    '.sig-plan must not use the --accent-strong / --accent hex')
  const restartBlock = findBlock('.turn-signal-chip.sig-plan-restart')
  assert.match(restartBlock, /var\(--signal-plan-restart-fg\)/,
    '.sig-plan-restart color must reference --signal-plan-restart-fg')

  // The Trace timeline/graph SVG variants (which share the same semantic)
  // must also route through the token so a future palette change stays in
  // sync across the chip + SVG surfaces.
  assert.match(CSS, /\.trace-timeline-signal-badge\.sig-plan\s*\{[^}]*var\(--signal-plan-fg\)/,
    'trace-timeline-signal-badge.sig-plan must fill via --signal-plan-fg')
  assert.match(CSS, /\.trace-graph-signal-ring\.sig-plan\s*\{[^}]*var\(--signal-plan-fg\)/,
    'trace-graph-signal-ring.sig-plan must stroke via --signal-plan-fg')
})

test('rubric-grid pass/fail cells route through --ok / --err tokens', () => {
  const passBlock = findBlock('.rubric-grid-cell--pass')
  const failBlock = findBlock('.rubric-grid-cell--fail')
  assert.match(passBlock, /var\(--ok\)/,
    '.rubric-grid-cell--pass background must reference var(--ok)')
  assert.match(failBlock, /var\(--err\)/,
    '.rubric-grid-cell--fail background must reference var(--err)')
  assert.ok(!/#79d17b|#f96e6e/.test(passBlock + failBlock),
    'rubric-grid pass/fail cells must not use raw #79d17b / #f96e6e hex')

  const passRateBlock = findBlock('.rubric-tile-stats-rate.pass')
  const failRateBlock = findBlock('.rubric-tile-stats-rate.fail')
  assert.match(passRateBlock, /var\(--ok-soft\)/,
    '.rubric-tile-stats-rate.pass background must reference var(--ok-soft)')
  assert.match(failRateBlock, /var\(--err-soft\)/,
    '.rubric-tile-stats-rate.fail background must reference var(--err-soft)')

  const passDotBlock = findBlock('.rubric-tile-stats-dot.pass')
  const failDotBlock = findBlock('.rubric-tile-stats-dot.fail')
  assert.match(passDotBlock, /var\(--ok\)/,
    '.rubric-tile-stats-dot.pass background must reference var(--ok)')
  assert.match(failDotBlock, /var\(--err\)/,
    '.rubric-tile-stats-dot.fail background must reference var(--err)')
})

test('rubric filter chip / runtimes tab active state routes through --accent-soft', () => {
  const chipActive = findBlock('.growth-fusion-filter-chip.active')
  assert.match(chipActive, /var\(--accent-soft\)/,
    '.growth-fusion-filter-chip.active must use --accent-soft, not raw violet')
  assert.ok(!/122,\s*90,\s*248/.test(chipActive),
    '.growth-fusion-filter-chip.active must not use raw violet rgba')

  const tabActive = findBlock('.runtimes-tab.active')
  assert.match(tabActive, /var\(--accent-soft\)/,
    '.runtimes-tab.active must use --accent-soft, not raw violet')
})

test('rubric-grid corner/row-head route through --muted (no manual dark override)', () => {
  const cornerBlock = findBlock('.rubric-grid-corner,\n.rubric-grid-row-head')
  assert.match(cornerBlock, /color:\s*var\(--muted\)/,
    'corner/row-head should color via --muted so dark mode follows automatically')
  // The pair-selector followed by a manual @media dark override was the
  // exact anti-pattern the review called out. Confirm it's gone.
  assert.ok(!/\.rubric-grid-corner,\s*\.rubric-grid-row-head\s*\{[^}]*rgba\(255,\s*255,\s*255/.test(CSS),
    'manual dark override for corner/row-head must not exist — --muted handles it')
})

test('rubric-grid-name size drops to 14px (three-size rule)', () => {
  const nameBlock = findBlock('.rubric-grid-name')
  assert.match(nameBlock, /font-size:\s*14px/,
    '.rubric-grid-name should be 14px to stay within the 3-size ladder')
})
