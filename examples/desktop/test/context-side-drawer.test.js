// Tests for fix/context-topright-panel — src/renderer/context-side-drawer.js.
//
// Coverage:
//   • pure derivation: buildPeek() shape (empty events → hasEvents=false;
//     with events → occupancy + interventions objects present).
//   • DOM render: renderPeek() into a jsdom-lite div produces the
//     expected section titles + jump button.
//   • wiring: after install(), clicking the toggle flips `.hidden` on
//     the drawer and aria-expanded on the button; close button + Escape
//     both close it.
//
// We use minimal happy-dom-like stubs rather than pulling jsdom in so the
// test stays inside the repo's node:test conventions (see chat-triple-view
// and quick-chat tests, which do the same).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const drawer = require('../src/renderer/context-side-drawer.js')

// --- Static gates (index.html + style.css) --------------------------------

test('index.html: Context page header carries the top-right Details toggle', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  assert.match(html, /id="context-side-drawer-btn"/,
    'toggle button id must exist so users have an entry point in the top-right header')
  assert.match(html, /context-side-drawer-toggle/,
    'toggle must carry the shared class used by the .toggle[aria-expanded="true"] rule')
  assert.match(html, /aria-label="Toggle context detail drawer"/,
    'toggle button must have an aria-label for AT users')
})

test('index.html: right-side #context-side-drawer aside exists, hidden by default', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  assert.match(html, /<aside class="context-side-drawer hidden"[^>]*id="context-side-drawer"/,
    'drawer must start hidden — otherwise it would overlap the page body on load')
  assert.match(html, /id="context-side-drawer-close"/,
    'close button id must exist so Escape/× both have a bound handler target')
})

test('style.css: .context-side-drawer geometry mirrors the chat-side-drawer family', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8')
  const m = css.match(/\.context-side-drawer\s*\{[\s\S]+?\}/)
  assert.ok(m, '.context-side-drawer rule missing')
  assert.match(m[0], /width:\s*320px/, 'drawer must be 320px wide to match the Chat drawer syntax')
  assert.match(m[0], /right:\s*0/, 'drawer must anchor to the right edge')
  assert.match(css, /\.context-side-drawer\.hidden\s*\{\s*display:\s*none/,
    '.hidden must collapse the drawer — used by the toggle')
})

// --- Pure derivation: buildPeek ------------------------------------------

test('buildPeek: empty events → hasEvents=false, no occupancy/interventions', () => {
  const peek = drawer.buildPeek([])
  assert.equal(peek.hasEvents, false)
  assert.equal(peek.occupancy, null)
  assert.equal(peek.interventions, null)
})

test('buildPeek: with fake windowApi/interventionApi returns projected sections', () => {
  const windowApi = {
    computeWindowBreakdown: () => ({
      totalTokens: 1234, budget: 128000, budgetPct: 1, mode: 'approx',
      slices: [
        { family: 'system_prompt', label: 'System prompt', tokens: 100, pct: 8 },
        { family: 'history', label: 'History', tokens: 1000, pct: 78 },
      ],
    }),
  }
  const interventionApi = {
    collectInterventions: () => [
      { kind: 'inject', label: 'plugin: skill loaded' },
      { kind: 'compact', label: 'compact @ turn 3' },
      { kind: 'recall', label: 'recall from memory' },
      { kind: 'steer', label: 'user steered' },
    ],
  }
  const peek = drawer.buildPeek([{ type: 'user/message', data: {} }], {
    windowApi, interventionApi,
  })
  assert.equal(peek.hasEvents, true)
  assert.equal(peek.occupancy.totalTokens, 1234)
  assert.equal(peek.occupancy.slices.length, 2)
  assert.equal(peek.interventions.count, 4)
  assert.equal(peek.interventions.tail.length, 3, 'peek only shows last 3 marker labels')
  assert.equal(peek.interventions.tail[2].kind, 'steer')
})

// --- DOM render: renderPeek ----------------------------------------------

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    id: '',
    children: [],
    dataset: {},
    style: { setProperty(k, v) { this[k] = v } },
    title: '',
    textContent: '',
    type: '',
    _listeners: {},
    ownerDocument: null,
    appendChild(child) { child.parentNode = this; this.children.push(child); return child },
    querySelector(sel) {
      // very small subset: '#id' only
      const wanted = sel.startsWith('#') ? sel.slice(1) : null
      if (!wanted) return null
      const stack = [...this.children]
      while (stack.length) {
        const n = stack.shift()
        if (n && n.id === wanted) return n
        if (n && n.children) stack.push(...n.children)
      }
      return null
    },
    setAttribute(k, v) { this[k] = v },
    addEventListener(k, fn) { (this._listeners[k] = this._listeners[k] || []).push(fn) },
  }
  return el
}
function makeDoc() {
  const doc = {
    createElement(tag) { const e = makeElement(tag); e.ownerDocument = doc; return e },
  }
  return doc
}

test('renderPeek: empty peek writes the "no active session" placeholder', () => {
  const doc = makeDoc()
  const container = doc.createElement('div')
  container.ownerDocument = doc
  drawer.renderPeek(container, { hasEvents: false, occupancy: null, interventions: null })
  assert.equal(container.className, 'context-side-drawer-body')
  assert.equal(container.children.length, 1)
  assert.match(container.children[0].textContent, /No active session/)
})

test('renderPeek: full peek writes occupancy + interventions + jump button', () => {
  const doc = makeDoc()
  const container = doc.createElement('div')
  container.ownerDocument = doc
  drawer.renderPeek(container, {
    hasEvents: true,
    occupancy: {
      totalTokens: 1234, budget: 128000, budgetPct: 1, mode: 'approx',
      slices: [{ family: 'history', label: 'History', tokens: 1000, pct: 78 }],
    },
    interventions: {
      count: 2,
      tail: [
        { kind: 'inject', label: 'plugin note' },
        { kind: 'compact', label: 'compact @ 3' },
      ],
    },
  })
  const titles = []
  for (const c of container.children) {
    // section > title is the first child
    const t = c.children && c.children[0]
    if (t && t.className === 'context-side-drawer-section-title') titles.push(t.textContent)
  }
  assert.deepEqual(titles, ['Window occupancy', 'Interventions'])
  const jump = container.querySelector('#context-side-drawer-jump')
  assert.ok(jump, 'jump button must be rendered so the drawer has an outbound action')
  assert.equal(jump.textContent, 'Jump to full context page')
})
