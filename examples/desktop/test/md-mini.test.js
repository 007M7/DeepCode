// Tests for the minimal Markdown → DOM renderer (src/renderer/md-mini.js).
// Two layers: (1) pure parse functions (parseBlocks / parseInline) exercised
// directly, and (2) the DOM builder run against a hand-rolled fake `document`
// so we can assert node types / textContent WITHOUT a browser — the whole
// security claim is "every model char reaches the DOM as a text node", and the
// fake document makes that observable.

'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const md = require('../src/renderer/md-mini.js')

// ---- fake DOM ------------------------------------------------------------
// Minimal enough for md-mini: createElement/createTextNode, appendChild,
// textContent (get walks children), className, setAttribute, addEventListener.

function makeNode(tag) {
  const node = {
    tagName: tag ? tag.toUpperCase() : undefined,
    nodeType: tag ? 1 : 3,
    children: [],
    childNodes: [],
    attrs: {},
    listeners: {},
    className: '',
    _text: '',
    appendChild(child) {
      this.childNodes.push(child)
      if (child.nodeType === 1) this.children.push(child)
      child.parentNode = this
      return child
    },
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    getAttribute(k) {
      return this.attrs[k]
    },
    addEventListener(ev, fn) {
      ;(this.listeners[ev] = this.listeners[ev] || []).push(fn)
    },
    set textContent(v) {
      this._text = String(v)
      this.childNodes = []
      this.children = []
    },
    get textContent() {
      if (this.nodeType === 3) return this._text
      if (this.childNodes.length === 0) return this._text
      return this.childNodes.map((c) => c.textContent).join('')
    },
  }
  return node
}

function fakeDoc() {
  return {
    createElement: (tag) => makeNode(tag),
    createTextNode: (t) => {
      const n = makeNode(null)
      n._text = String(t)
      return n
    },
  }
}

function render(src, onLink) {
  return md.render(src, { document: fakeDoc(), onLink })
}

// walk helper: collect all descendant element nodes with a given tag
function findAll(root, tag) {
  const out = []
  const want = tag.toUpperCase()
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 1) {
        if (c.tagName === want) out.push(c)
        walk(c)
      }
    }
  }
  walk(root)
  return out
}

// ---- parseBlocks ---------------------------------------------------------

test('md-mini: headings h1..h6 parse with level and text', () => {
  const { blocks } = md.parseBlocks('# One\n## Two\n###### Six')
  assert.deepEqual(
    blocks.map((b) => [b.type, b.level, b.text]),
    [
      ['heading', 1, 'One'],
      ['heading', 2, 'Two'],
      ['heading', 6, 'Six'],
    ],
  )
})

test('md-mini: 7 hashes is not a heading (paragraph)', () => {
  const { blocks } = md.parseBlocks('####### nope')
  assert.equal(blocks[0].type, 'paragraph')
})

test('md-mini: fenced code captured verbatim, no inline parse', () => {
  const { blocks } = md.parseBlocks('```js\nconst x = **not bold**\n```')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].lang, 'js')
  assert.equal(blocks[0].text, 'const x = **not bold**')
})

test('md-mini: tilde fence closes only on tildes', () => {
  const { blocks } = md.parseBlocks('~~~\n```\nstill code\n~~~')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].text, '```\nstill code')
})

test('md-mini: unordered list groups consecutive items', () => {
  const { blocks } = md.parseBlocks('- a\n- b\n* c')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'list')
  assert.equal(blocks[0].ordered, false)
  assert.deepEqual(blocks[0].items, ['a', 'b', 'c'])
})

test('md-mini: ordered and unordered lists split into separate blocks', () => {
  const { blocks } = md.parseBlocks('1. a\n2. b\n- c')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].ordered, true)
  assert.deepEqual(blocks[0].items, ['a', 'b'])
  assert.equal(blocks[1].ordered, false)
  assert.deepEqual(blocks[1].items, ['c'])
})

test('md-mini: blockquote merges consecutive lines', () => {
  const { blocks } = md.parseBlocks('> line one\n> line two')
  assert.equal(blocks[0].type, 'quote')
  assert.equal(blocks[0].text, 'line one line two')
})

test('md-mini: horizontal rule vs list disambiguation', () => {
  const hr = md.parseBlocks('---')
  assert.equal(hr.blocks[0].type, 'hr')
  const list = md.parseBlocks('- item')
  assert.equal(list.blocks[0].type, 'list')
})

test('md-mini: paragraph joins soft-wrapped lines', () => {
  const { blocks } = md.parseBlocks('hello\nworld\n\nsecond')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, 'hello world')
  assert.equal(blocks[1].text, 'second')
})

test('md-mini: blank input yields no blocks, not truncated', () => {
  const { blocks, truncated } = md.parseBlocks('')
  assert.deepEqual(blocks, [])
  assert.equal(truncated, false)
})

test('md-mini: length cap at MAX_LINES sets truncated', () => {
  const many = Array.from({ length: md.MAX_LINES + 50 }, (_, i) => 'line ' + i).join('\n')
  const { blocks, truncated } = md.parseBlocks(many)
  assert.equal(truncated, true)
  // Only the first MAX_LINES lines fed the parser; they collapse into one
  // paragraph (soft-wrapped), so assert the last surviving line made it and
  // the first dropped one did not.
  const text = blocks.map((b) => b.text || '').join(' ')
  assert.ok(text.includes('line ' + (md.MAX_LINES - 1)))
  assert.ok(!text.includes('line ' + md.MAX_LINES))
})

// ---- parseInline ---------------------------------------------------------

test('md-mini: inline code is verbatim and beats other markup', () => {
  const toks = md.parseInline('a `**b**` c')
  assert.deepEqual(
    toks.map((t) => [t.type, t.text]),
    [
      ['text', 'a '],
      ['code', '**b**'],
      ['text', ' c'],
    ],
  )
})

test('md-mini: strong and emphasis', () => {
  assert.equal(md.parseInline('**x**')[0].type, 'strong')
  assert.equal(md.parseInline('__x__')[0].type, 'strong')
  assert.equal(md.parseInline('*x*')[0].type, 'em')
  assert.equal(md.parseInline('_x_')[0].type, 'em')
})

test('md-mini: link token carries text and href', () => {
  const toks = md.parseInline('see [docs](https://x.test/p)')
  const link = toks.find((t) => t.type === 'link')
  assert.equal(link.text, 'docs')
  assert.equal(link.href, 'https://x.test/p')
})

test('md-mini: lone asterisk is literal text', () => {
  const toks = md.parseInline('2 * 3 = 6')
  assert.equal(toks.length, 1)
  assert.equal(toks[0].type, 'text')
  assert.equal(toks[0].text, '2 * 3 = 6')
})

test('md-mini: isSafeHref whitelist', () => {
  assert.equal(md.isSafeHref('https://x.test'), true)
  assert.equal(md.isSafeHref('http://x.test'), true)
  assert.equal(md.isSafeHref('mailto:a@b.test'), true)
  assert.equal(md.isSafeHref('javascript:alert(1)'), false)
  assert.equal(md.isSafeHref('data:text/html,<script>'), false)
  assert.equal(md.isSafeHref('file:///etc/passwd'), false)
})

// ---- DOM build + security ------------------------------------------------

test('md-mini: render produces expected element tags', () => {
  const root = render('# Title\n\npara\n\n- a\n- b\n\n> quote\n\n```\ncode\n```')
  assert.equal(findAll(root, 'h1').length, 1)
  assert.equal(findAll(root, 'p').length, 1)
  assert.equal(findAll(root, 'ul').length, 1)
  assert.equal(findAll(root, 'li').length, 2)
  assert.equal(findAll(root, 'blockquote').length, 1)
  assert.equal(findAll(root, 'pre').length, 1)
})

test('md-mini: raw HTML in markdown stays literal text (no nodes)', () => {
  const evil = 'before <script>alert(1)</script> <img src=x onerror=alert(2)> after'
  const root = render(evil)
  // No <script> or <img> element was ever created.
  assert.equal(findAll(root, 'script').length, 0)
  assert.equal(findAll(root, 'img').length, 0)
  // The angle-bracket text survives verbatim in the paragraph textContent.
  assert.ok(root.textContent.includes('<script>alert(1)</script>'))
  assert.ok(root.textContent.includes('<img src=x onerror=alert(2)>'))
})

test('md-mini: HTML inside fenced code stays literal', () => {
  const root = render('```\n<script>evil()</script>\n```')
  assert.equal(findAll(root, 'script').length, 0)
  const pre = findAll(root, 'pre')[0]
  assert.equal(pre.textContent, '<script>evil()</script>')
})

test('md-mini: safe link builds <a> with click routed to onLink, default prevented', () => {
  const opened = []
  const root = render('[go](https://x.test/p)', (href) => opened.push(href))
  const a = findAll(root, 'a')[0]
  assert.ok(a)
  assert.equal(a.getAttribute('href'), 'https://x.test/p')
  assert.equal(a.getAttribute('rel'), 'noreferrer noopener')
  let prevented = false
  a.listeners.click[0]({ preventDefault: () => (prevented = true) })
  assert.equal(prevented, true)
  assert.deepEqual(opened, ['https://x.test/p'])
})

test('md-mini: unsafe link scheme renders inert text, no <a>', () => {
  const opened = []
  const root = render('[click](javascript:alert(1))', (href) => opened.push(href))
  assert.equal(findAll(root, 'a').length, 0)
  assert.ok(root.textContent.includes('click'))
  assert.deepEqual(opened, [])
})

test('md-mini: nested emphasis inside strong', () => {
  const root = render('**bold _and italic_**')
  const strong = findAll(root, 'strong')[0]
  assert.ok(strong)
  assert.equal(findAll(strong, 'em').length, 1)
})

test('md-mini: truncated note appended past cap', () => {
  const many = Array.from({ length: md.MAX_LINES + 10 }, () => 'x').join('\n')
  const root = render(many)
  const note = root.childNodes.find(
    (c) => c.nodeType === 1 && c.className === 'md-mini-truncated',
  )
  assert.ok(note, 'expected a truncated note element')
  assert.ok(note.textContent.includes(String(md.MAX_LINES)))
})

// ---- registration --------------------------------------------------------

test('md-mini: registered as a script in index.html before artifacts.js', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8',
  )
  const mdIdx = html.indexOf('"./md-mini.js"')
  const artIdx = html.indexOf('"./artifacts.js"')
  assert.ok(mdIdx > -1, 'md-mini.js must be script-registered')
  assert.ok(mdIdx < artIdx, 'md-mini.js must load before artifacts.js')
})
