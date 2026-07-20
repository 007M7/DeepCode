// Lock the artifact-card compact row shape (density-spec §2 L0, user
// directive 2026-07-18 P0). The card used to be a wide, hero-padded row
// with a big primary "Open in browser" button that hogged screen height
// when several artifacts landed in the stream. The fix reshapes it to:
//
//   * `<details class="artifact-card">` with a native `<summary>`
//     row (`.artifact-row`) — collapsed by default, expands inline.
//   * L0 row = small 14px icon + filename + kind chip + version chip +
//     live dot + tiny `open ↗` link (no primary button).
//   * L1 body (`.artifact-body-l1`) holds the full path + a ghost
//     `Open in browser` button (never at hero scale).
//   * Consecutive `.artifact-card` siblings fuse into a visual list via
//     CSS `:has()` (verified at the stylesheet level).
//
// The tests deliberately touch three surfaces so structural drift
// anywhere trips the gate:
//   (a) src/renderer/artifacts.js — DOM builder (source strings).
//   (b) src/renderer/style.css     — row height, L1 body, group fusing.
//   (c) IIFE contract              — window.__dshArtifacts.onArtifactEvent.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const artifactsSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/artifacts.js'), 'utf8')
const styleCss = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8')

// ---------- (a) DOM builder shape ----------------------------------------

test('artifacts.js: card root is a <details> element (not a bare div)', () => {
  assert.match(
    artifactsSrc,
    /createElement\(['"]details['"]\)[\s\S]{0,120}el\.className\s*=\s*['"]artifact-card['"]/,
    'artifact-card root must be built as <details> so the row expands inline'
  )
})

test('artifacts.js: L0 row uses <summary class="artifact-row">', () => {
  assert.match(
    artifactsSrc,
    /createElement\(['"]summary['"]\)[\s\S]{0,120}summary\.className\s*=\s*['"]artifact-row['"]/,
    'compact row must be a <summary> with class="artifact-row"'
  )
})

test('artifacts.js: L0 renders a tiny `open ↗` link (not a primary button)', () => {
  // The link is on the summary row; the big button moved to the L1 body.
  assert.match(
    artifactsSrc,
    /className\s*=\s*['"]artifact-open-link['"]/,
    'summary row must render an .artifact-open-link tiny action'
  )
  assert.match(
    artifactsSrc,
    /open\s+↗/,
    'action label must be `open ↗` (density-spec §2 L0 icon/link scale)'
  )
})

test('artifacts.js: L0 summary does NOT render an .artifact-open.primary button', () => {
  // The old wide-card shape had `openBtn.className = 'artifact-open primary'`
  // *directly on the summary row*. The primary button is banned from L0.
  assert.doesNotMatch(
    artifactsSrc,
    /['"]artifact-open primary['"]/,
    'the hero primary button must not exist anywhere; L0 uses a link, L1 uses a ghost button'
  )
})

test('artifacts.js: L1 body wrapper exists with .artifact-body-l1', () => {
  assert.match(
    artifactsSrc,
    /className\s*=\s*['"]artifact-body-l1['"]/,
    'L1 body wrapper must be rendered so users can expand for details'
  )
})

test('artifacts.js: L1 body contains a ghost "Open in browser" button', () => {
  // Ghost/small classes are the density-spec convention for non-hero
  // actions used elsewhere (see .ghost.small usage across renderer).
  assert.match(
    artifactsSrc,
    /artifact-open ghost small[\s\S]{0,80}Open in browser/,
    'L1 body must expose an Open-in-browser action at ghost/small scale'
  )
})

test('artifacts.js: still exposes window.__dshArtifacts.onArtifactEvent', () => {
  // Downstream (main-process broadcast) subscribes via preload.onArtifact,
  // but this seam is what the debug menu + smoke tests hit.
  assert.match(
    artifactsSrc,
    /window\.__dshArtifacts\s*=\s*\{[\s\S]*?onArtifactEvent[\s\S]*?\}/,
    '__dshArtifacts.onArtifactEvent seam must remain (mock button + tests)'
  )
})

test('artifacts.js: openArtifact IPC still wired through window.dsh.openArtifact', () => {
  assert.match(
    artifactsSrc,
    /window\.dsh\.openArtifact\(entry\.artifactId\)/,
    'preload → main open bridge must still be the mechanism for open ↗'
  )
})

test('artifacts.js: appendGrouped wraps consecutive cards into an .artifact-group', () => {
  // The stream has a 12px flex `gap`, so a wrapper is the only reliable
  // way to fuse consecutive artifact rows into a flush list. Locks the
  // renderer path that creates .artifact-group as-needed.
  assert.match(
    artifactsSrc,
    /function\s+appendGrouped\(/,
    'appendGrouped helper must exist to fuse consecutive artifact cards'
  )
  assert.match(
    artifactsSrc,
    /group\.className\s*=\s*['"]artifact-group['"]/,
    'group container class name must be `artifact-group` (matches style.css)'
  )
})

test('style.css: .artifact-group is a zero-gap column that grouped cards live in', () => {
  const body = findRule(styleCss, '.artifact-group {')
  assert.ok(body, '.artifact-group rule must exist')
  assert.match(body, /gap:\s*0/, 'group gap must be 0 so grouped rows sit flush')
  assert.match(body, /flex-direction:\s*column/, 'group is a vertical stack')
})

test('style.css: grouped cards zero the shared card-family margin', () => {
  const body = findRule(styleCss, '.artifact-group > .artifact-card {')
  assert.ok(body, 'grouped-card rule must exist')
  assert.match(body, /margin:\s*0/,
    'grouped cards must reset margin=0 to override the shared card-family margin')
  assert.match(body, /border-top:\s*none/,
    'grouped cards must drop top-border to collapse the shared seam')
})

// ---------- (b) CSS: row height, L1 body, group fusing --------------------

function findRule(css, selector) {
  // Naive but adequate: match `selector { … }` for a single leaf rule.
  // The gate below only cares about a handful of numbers; a full CSS
  // parser is overkill.
  const idx = css.indexOf(selector)
  if (idx < 0) return null
  const brace = css.indexOf('{', idx)
  const close = css.indexOf('}', brace)
  if (brace < 0 || close < 0) return null
  return css.slice(brace + 1, close)
}

test('style.css: .artifact-row has min-height ≤ 32px (L0 compact)', () => {
  const body = findRule(styleCss, '.artifact-row {')
  assert.ok(body, '.artifact-row rule must exist')
  const m = body.match(/min-height:\s*(\d+)px/)
  assert.ok(m, '.artifact-row must declare min-height')
  const px = Number(m[1])
  assert.ok(px <= 32, `L0 row min-height must be ≤ 32px, found ${px}px`)
})

test('style.css: .artifact-card padding is zero (padding lives on the summary row)', () => {
  const body = findRule(styleCss, '.artifact-card {')
  assert.ok(body, '.artifact-card rule must exist')
  // Old fat rule was `padding: 10px 12px;` — verify the flat card has
  // shed it so the summary can drive its own compact padding.
  assert.match(body, /padding:\s*0\s*;/, '.artifact-card must have padding:0 (row owns spacing)')
})

test('style.css: .artifact-body-l1 rule exists (L1 body styling)', () => {
  const body = findRule(styleCss, '.artifact-body-l1 {')
  assert.ok(body, '.artifact-body-l1 rule must be defined for the expanded body')
  assert.match(body, /border-top:\s*1px solid var\(--border\)/,
    'L1 body must sit under a divider so the row/body split is legible')
})

test('style.css: adjacent artifact-cards fuse via `:has(+ .artifact-card)`', () => {
  assert.match(
    styleCss,
    /\.artifact-card:has\(\+\s*\.artifact-card\)/,
    'auto-group fusing rule must exist so ≥2 cards render as one list'
  )
  assert.match(
    styleCss,
    /\.artifact-card\s*\+\s*\.artifact-card/,
    'sibling combinator must exist to close the seam between adjacent cards'
  )
})

test('style.css: no hero `.artifact-open.primary` style survives', () => {
  // Belt & suspenders — the DOM never emits it AND the stylesheet drops
  // the class name entirely.
  assert.doesNotMatch(
    styleCss,
    /\.artifact-open\.primary\b/,
    'primary variant of .artifact-open must not exist; L0 has no hero button'
  )
})

test('style.css: .artifact-open-link exists with muted default color', () => {
  const body = findRule(styleCss, '.artifact-open-link {')
  assert.ok(body, '.artifact-open-link rule must be defined')
  assert.match(body, /color:\s*var\(--muted\)/,
    'the tiny action link defaults to muted so it reads as a link, not a button')
})
