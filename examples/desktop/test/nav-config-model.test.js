// nav-config-model.test.js — pure config helpers + static HTML gates for
// the left-nav hiddenPages filter (lane-nav-optional).
//
// Three fixture cases (task spec):
//   • config.json missing `hiddenPages`      → default hidden set (Playground + Missions)
//   • config.json has empty array            → nothing hidden (all pages show)
//   • config.json has custom list            → honored as-is (e.g. ["prs","growth"])
//
// Plus DOM-shape assertions on index.html so a future rewrite of the
// sidebar can't silently strip the Optional pages section.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const M = require('../src/renderer/nav-config-model.js')

// -- resolveHiddenPages ----------------------------------------------------

test('resolveHiddenPages: no config → default hidden set', () => {
  assert.deepStrictEqual(M.resolveHiddenPages(null), ['playground-shim', 'mission'])
  assert.deepStrictEqual(M.resolveHiddenPages(undefined), ['playground-shim', 'mission'])
  assert.deepStrictEqual(M.resolveHiddenPages({}), ['playground-shim', 'mission'])
})

test('resolveHiddenPages: hiddenPages missing on partial config → default set', () => {
  const cfg = { role: 'engineer', approvalMode: 'ask', createdAt: 1234 }
  assert.deepStrictEqual(M.resolveHiddenPages(cfg), ['playground-shim', 'mission'])
})

test('resolveHiddenPages: empty array → show everything', () => {
  assert.deepStrictEqual(M.resolveHiddenPages({ hiddenPages: [] }), [])
})

test('resolveHiddenPages: custom list → honored as-is', () => {
  assert.deepStrictEqual(
    M.resolveHiddenPages({ hiddenPages: ['prs', 'growth'] }),
    ['prs', 'growth']
  )
})

test('resolveHiddenPages: non-array garbage → falls back to defaults (safe)', () => {
  assert.deepStrictEqual(M.resolveHiddenPages({ hiddenPages: 'playground' }), ['playground-shim', 'mission'])
  assert.deepStrictEqual(M.resolveHiddenPages({ hiddenPages: 42 }), ['playground-shim', 'mission'])
  assert.deepStrictEqual(M.resolveHiddenPages({ hiddenPages: { pages: [] } }), ['playground-shim', 'mission'])
})

test('resolveHiddenPages: filters out non-string / blank entries', () => {
  assert.deepStrictEqual(
    M.resolveHiddenPages({ hiddenPages: ['prs', '', null, 42, 'growth'] }),
    ['prs', 'growth']
  )
})

test('resolveHiddenPages: returns a fresh array (mutation safety)', () => {
  const a = M.resolveHiddenPages({})
  a.push('sneaky')
  const b = M.resolveHiddenPages({})
  assert.deepStrictEqual(b, ['playground-shim', 'mission'],
    'a subsequent call must not see the mutation of a prior return')
})

// -- toggleOptionalPage -----------------------------------------------------

test('toggleOptionalPage: enable removes the id from hidden', () => {
  assert.deepStrictEqual(
    M.toggleOptionalPage(['playground-shim', 'mission'], 'playground-shim', true).sort(),
    ['mission']
  )
})

test('toggleOptionalPage: disable adds the id to hidden', () => {
  assert.deepStrictEqual(
    M.toggleOptionalPage(['mission'], 'playground-shim', false).sort(),
    ['mission', 'playground-shim']
  )
})

test('toggleOptionalPage: idempotent — disable an already-hidden page = no change', () => {
  assert.deepStrictEqual(
    M.toggleOptionalPage(['mission'], 'mission', false).sort(),
    ['mission']
  )
})

test('toggleOptionalPage: idempotent — enable an already-visible page = no change', () => {
  assert.deepStrictEqual(
    M.toggleOptionalPage(['mission'], 'playground-shim', true).sort(),
    ['mission']
  )
})

test('toggleOptionalPage: non-array current is tolerated (start fresh)', () => {
  assert.deepStrictEqual(
    M.toggleOptionalPage(undefined, 'mission', false).sort(),
    ['mission']
  )
  assert.deepStrictEqual(
    M.toggleOptionalPage(null, 'mission', true).sort(),
    []
  )
})

// -- OPTIONAL_PAGES shape ---------------------------------------------------

test('OPTIONAL_PAGES: matches DEFAULT_HIDDEN 1:1 by id', () => {
  const optIds = M.OPTIONAL_PAGES.map((p) => p.id).sort()
  const defIds = M.DEFAULT_HIDDEN.slice().sort()
  assert.deepStrictEqual(optIds, defIds,
    'every default-hidden page should have a Settings checkbox and vice versa')
})

test('OPTIONAL_PAGES: every entry has id/label/hint strings', () => {
  for (const page of M.OPTIONAL_PAGES) {
    assert.ok(typeof page.id === 'string' && page.id.length > 0, `id: ${JSON.stringify(page)}`)
    assert.ok(typeof page.label === 'string' && page.label.length > 0, `label: ${JSON.stringify(page)}`)
    assert.ok(typeof page.hint === 'string' && page.hint.length > 0, `hint: ${JSON.stringify(page)}`)
  }
})

// -- static HTML gate: Optional pages section --------------------------------

const HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/index.html'),
  'utf8'
)

test('Optional pages section is declared in the Settings pane', () => {
  assert.match(HTML, /data-settings-optional-pages/,
    'Optional pages section marker present')
  assert.match(HTML, /data-settings-optional-list/,
    'Optional pages list hook present')
  assert.match(HTML, /Optional pages/,
    'Section title copy present')
})

test('Optional pages section lives inside the Settings pane (not orphaned)', () => {
  // Grab settings-pane block through its closing tag and assert the
  // Optional marker sits inside. Guards against a merge that moves the
  // block out of the pane by accident.
  const paneMatch = HTML.match(/id="settings-pane"[\s\S]*?<\/section>\s*<\/section>/)
  assert.ok(paneMatch, 'settings-pane block found')
  assert.match(paneMatch[0], /data-settings-optional-pages/,
    'Optional pages section must live inside #settings-pane')
})

test('nav-config-model.js is loaded before settings-page.js', () => {
  const navMatch = HTML.match(/<script[^>]*src="\.\/nav-config-model\.js"/)
  const settingsMatch = HTML.match(/<script[^>]*src="\.\/settings-page\.js"/)
  assert.ok(navMatch, 'nav-config-model.js script tag present')
  assert.ok(settingsMatch, 'settings-page.js script tag present')
  const navIdx = HTML.indexOf(navMatch[0])
  const settingsIdx = HTML.indexOf(settingsMatch[0])
  assert.ok(settingsIdx > navIdx,
    'nav-config-model must load before settings-page so OPTIONAL_PAGES is defined at render time')
})

test('Playground-shim + mission buttons expose the data-tab ids the filter matches', () => {
  // These two ids are the default-hidden set — if a lane renames either
  // without also updating nav-config-model.DEFAULT_HIDDEN, the filter
  // would silently no-op and both buttons would show up on fresh installs.
  assert.match(HTML, /data-tab="playground-shim"/,
    'playground-shim button id must match DEFAULT_HIDDEN entry')
  assert.match(HTML, /data-tab="mission"/,
    'mission button id must match DEFAULT_HIDDEN entry')
})

// -- DOM-level filter proof (three fixture cases) --------------------------
// Mirror the loop inside renderer.js:applyNavHiddenPages() against a tiny
// shim so each fixture case is proven end-to-end: config in →
// hiddenPages resolved → class toggled on matching button. Using a
// hand-rolled shim rather than jsdom (not a dev-dep) or the full
// renderer-harness (evals 8k lines of renderer.js for a one-loop check).

function makeSidebar() {
  const buttons = []
  const groups = []
  function makeBtn(dataTab) {
    return {
      dataset: { tab: dataTab },
      classList: {
        _s: new Set(),
        toggle(n, force) {
          if (force) this._s.add(n); else this._s.delete(n)
          return force
        },
        contains(n) { return this._s.has(n) },
      },
    }
  }
  function makeGroup(btns) {
    const g = {
      classList: {
        _s: new Set(),
        toggle(n, force) {
          if (force) this._s.add(n); else this._s.delete(n)
          return force
        },
        contains(n) { return this._s.has(n) },
      },
      _btns: btns,
    }
    for (const b of btns) buttons.push(b)
    groups.push(g)
    return g
  }
  makeGroup([
    makeBtn('chat'),
    makeBtn('tree'),
    makeBtn('context'),
    makeBtn('tracing'),
  ])
  // "iteration" group — playground-shim (default hidden) sits here.
  makeGroup([
    makeBtn('playground-shim'),
    makeBtn('hub'),
    makeBtn('bench'),
  ])
  // "runtime" group — mission (default hidden) sits here.
  makeGroup([
    makeBtn('rubrics'),
    makeBtn('plugins'),
    makeBtn('runtimes'),
    makeBtn('mission'),
    makeBtn('growth'),
    makeBtn('prs'),
  ])
  return { buttons, groups }
}

function applyFilter(sidebar, cfg) {
  const hidden = new Set(M.resolveHiddenPages(cfg))
  for (const b of sidebar.buttons) {
    b.classList.toggle('nav-item--hidden', hidden.has(b.dataset.tab))
  }
  for (const g of sidebar.groups) {
    const allHidden = g._btns.every((b) => b.classList.contains('nav-item--hidden'))
    g.classList.toggle('nav-group--hidden', allHidden)
  }
}

test('DOM filter (case 1): missing hiddenPages → playground-shim + mission hidden, others visible', () => {
  const sb = makeSidebar()
  applyFilter(sb, {})
  const hidden = sb.buttons.filter((b) => b.classList.contains('nav-item--hidden'))
  assert.deepStrictEqual(
    hidden.map((b) => b.dataset.tab).sort(),
    ['mission', 'playground-shim']
  )
})

test('DOM filter (case 2): empty array → nothing hidden (all pages show)', () => {
  const sb = makeSidebar()
  applyFilter(sb, { hiddenPages: [] })
  const hidden = sb.buttons.filter((b) => b.classList.contains('nav-item--hidden'))
  assert.strictEqual(hidden.length, 0, 'no buttons should be hidden with []')
  const groupHidden = sb.groups.filter((g) => g.classList.contains('nav-group--hidden'))
  assert.strictEqual(groupHidden.length, 0, 'no groups should be collapsed with []')
})

test('DOM filter (case 3): custom list → matching buttons hidden, others untouched', () => {
  const sb = makeSidebar()
  applyFilter(sb, { hiddenPages: ['prs', 'growth'] })
  const hidden = sb.buttons.filter((b) => b.classList.contains('nav-item--hidden'))
  assert.deepStrictEqual(
    hidden.map((b) => b.dataset.tab).sort(),
    ['growth', 'prs']
  )
  // Playground + mission are NOT hidden because the researcher opted them in
  // via an explicit list; only the ids in the list are hidden.
  const play = sb.buttons.find((b) => b.dataset.tab === 'playground-shim')
  const mission = sb.buttons.find((b) => b.dataset.tab === 'mission')
  assert.ok(!play.classList.contains('nav-item--hidden'), 'playground-shim visible on custom list')
  assert.ok(!mission.classList.contains('nav-item--hidden'), 'mission visible on custom list')
})

test('DOM filter: group collapses when every button inside is hidden', () => {
  const sb = makeSidebar()
  // Hide every button in the iteration group.
  applyFilter(sb, { hiddenPages: ['playground-shim', 'hub', 'bench'] })
  const iterGroup = sb.groups[1] // second group is "iteration"
  assert.ok(iterGroup.classList.contains('nav-group--hidden'),
    'iteration group should be collapsed when all its buttons are hidden')
  // The other groups still have visible members.
  assert.ok(!sb.groups[0].classList.contains('nav-group--hidden'))
  assert.ok(!sb.groups[2].classList.contains('nav-group--hidden'))
})

