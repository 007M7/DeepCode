// Unit tests for src/renderer/plugins-mcp-card.js. The DOM-heavy parts are
// exercised by wiring a minimal DOM stub; the pure helpers (summarize / pack
// / validate / isMcpClientRow) get direct-call coverage.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/plugins-mcp-card.js')

test('summarize: empty config renders (unconfigured)', () => {
  assert.equal(M.summarize(null), '(unconfigured)')
  assert.equal(M.summarize({}), '(unconfigured)')
})

test('summarize: stdio shows serverName + transport + command', () => {
  assert.equal(
    M.summarize({ transport: 'stdio', serverName: 'github', command: 'npx' }),
    'github · stdio · npx',
  )
})

test('summarize: missing serverName rendered explicitly', () => {
  assert.equal(
    M.summarize({ transport: 'stdio', command: 'npx' }),
    '(no serverName) · stdio · npx',
  )
})

test('summarize: streamable-http shows serverName + transport + url', () => {
  assert.equal(
    M.summarize({ transport: 'streamable-http', serverName: 'grafana', url: 'https://x.example/rpc' }),
    'grafana · http · https://x.example/rpc',
  )
})

test('pack: stdio state omits empty env/args, keeps transport', () => {
  const cfg = M.pack({
    transport: 'stdio',
    serverName: 'github',
    command: 'npx',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
  })
  assert.deepEqual(cfg, {
    transport: 'stdio',
    serverName: 'github',
    command: 'npx',
  })
})

test('pack: stdio state preserves args + env when non-empty', () => {
  const cfg = M.pack({
    transport: 'stdio',
    serverName: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_x' },
    cwd: '/tmp/work',
    url: '',
    headers: {},
  })
  assert.deepEqual(cfg, {
    transport: 'stdio',
    serverName: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_x' },
    cwd: '/tmp/work',
  })
})

test('pack: streamable-http state omits stdio-only fields', () => {
  const cfg = M.pack({
    transport: 'streamable-http',
    serverName: 'grafana',
    command: 'npx',        // stray from a previous transport — should be dropped
    args: ['-y'],          // ditto
    env: { X: '1' },       // ditto
    cwd: '/tmp',           // ditto
    url: 'https://x.example',
    headers: { Authorization: 'Bearer x' },
  })
  assert.deepEqual(cfg, {
    transport: 'streamable-http',
    serverName: 'grafana',
    url: 'https://x.example',
    headers: { Authorization: 'Bearer x' },
  })
})

test('pack: empty-string entries in args list are filtered', () => {
  const cfg = M.pack({
    transport: 'stdio', serverName: 'x', command: 'npx',
    args: ['-y', '', 'pkg', ''],
    env: {}, cwd: '', url: '', headers: {},
  })
  assert.deepEqual(cfg.args, ['-y', 'pkg'])
})

test('validate: serverName required', () => {
  const v = M.validate({ transport: 'stdio', serverName: '', command: 'npx' })
  assert.match(v.error, /serverName is required/)
})

test('validate: serverName charset enforced', () => {
  const v = M.validate({ transport: 'stdio', serverName: 'has spaces', command: 'npx' })
  assert.match(v.error, /serverName must be/)
})

test('validate: stdio requires command', () => {
  const v = M.validate({ transport: 'stdio', serverName: 'gh', command: '' })
  assert.match(v.error, /command is required/)
})

test('validate: streamable-http requires url', () => {
  const v = M.validate({ transport: 'streamable-http', serverName: 'gh', url: '' })
  assert.match(v.error, /url is required/)
})

test('validate: streamable-http url must be http(s)://', () => {
  const v = M.validate({ transport: 'streamable-http', serverName: 'gh', url: 'ftp://x' })
  assert.match(v.error, /http:\/\/ or https:\/\//)
})

test('validate: happy path (stdio + serverName + command) returns no error', () => {
  const v = M.validate({ transport: 'stdio', serverName: 'github', command: 'npx' })
  assert.equal(v.error, null)
})

test('validate: happy path (http + serverName + url) returns no error', () => {
  const v = M.validate({ transport: 'streamable-http', serverName: 'grafana',
    url: 'https://mcp.example.com' })
  assert.equal(v.error, null)
})

test('isMcpClientRow: matches @deepseek-ai/dsh-mcp-client', () => {
  assert.equal(M.isMcpClientRow({ id: 'mcp-client', name: '@deepseek-ai/dsh-mcp-client' }), true)
})

test('isMcpClientRow: matches local path variants', () => {
  assert.equal(M.isMcpClientRow({ id: 'x', name: '../deepseek-harness-dev/packages/mcp/mcp-client/src' }), true)
})

test('isMcpClientRow: does not match unrelated plugins', () => {
  assert.equal(M.isMcpClientRow({ id: 'bash', name: '@deepseek-ai/dsh-bash-local' }), false)
  assert.equal(M.isMcpClientRow({ id: 'x' }), false)
  assert.equal(M.isMcpClientRow(null), false)
})

// DOM smoke test: buildMcpConfigCard should return a <tr> that (a) has
// colSpan=5 on its single cell so the row lines up with the plugins table,
// (b) opens with the details panel expanded, (c) exposes a Save button
// wired to the api.onCommit callback, and (d) surfaces the serverName
// preview in the summary bar once committed.
test('buildMcpConfigCard: renders a wide-row card and wires save/clear', async () => {
  const doc = makeStubDoc()
  let committed = null
  let cleared = false
  const api = {
    onCommit: async (cfg) => { committed = cfg },
    onClear: async () => { cleared = true },
  }
  const tr = M.buildMcpConfigCard(doc, {
    id: 'gh-mcp',
    name: '@deepseek-ai/dsh-mcp-client',
    disabled: false,
    source: 'user',
    config: { transport: 'stdio', serverName: 'github', command: 'npx' },
  }, api)
  assert.equal(tr.tagName, 'tr')
  const td = tr.children[0]
  assert.equal(td.tagName, 'td')
  assert.equal(td.colSpan, 5)
  const details = td.children[0]
  assert.equal(details.tagName, 'details')
  assert.equal(details.open, true)
  // Restart-required badge must be present so the user knows Apply-restart
  // is required for the change to take effect.
  const badge = findByClass(details, 'mcp-config-restart-badge')
  assert.ok(badge, 'restart-required badge should render')
  // The Save button starts disabled (nothing dirty yet); flipping the
  // command input to a new value should enable it, and clicking it should
  // invoke api.onCommit with the packed config.
  const saveBtn = findByClass(details, 'mcp-config-save')
  assert.ok(saveBtn)
  assert.equal(saveBtn.disabled, true)

  // Simulate the user typing a new command; input handlers wire dirty().
  const cmdInput = findInputByPlaceholder(details, /npx, node, python/)
  cmdInput.value = 'python -m server'
  cmdInput.dispatchEvent({ type: 'input' })
  assert.equal(saveBtn.disabled, false, 'save should enable after edit')

  await clickAndAwait(saveBtn)
  assert.ok(committed, 'onCommit should have fired')
  assert.equal(committed.command, 'python -m server')
  assert.equal(committed.serverName, 'github')
  assert.equal(committed.transport, 'stdio')

  // Clear invokes onClear.
  const clearBtn = findByClass(details, 'mcp-config-clear')
  await clickAndAwait(clearBtn)
  assert.equal(cleared, true)
})

test('buildMcpConfigCard: streamable-http transport hides stdio fields', () => {
  const doc = makeStubDoc()
  const tr = M.buildMcpConfigCard(doc, {
    id: 'grafana', name: '@deepseek-ai/dsh-mcp-client', disabled: false, source: 'user',
    config: { transport: 'streamable-http', serverName: 'grafana',
      url: 'https://mcp.example.com' },
  }, { onCommit: async () => {}, onClear: async () => {} })
  const details = tr.children[0].children[0]
  // Command placeholder must NOT be present when we're in streamable-http.
  const cmdInput = findInputByPlaceholder(details, /npx, node, python/, { optional: true })
  assert.equal(cmdInput, null, 'stdio-only command field should be absent')
  // URL placeholder must be present.
  const urlInput = findInputByPlaceholder(details, /mcp.example.com/)
  assert.ok(urlInput, 'streamable-http url field should be present')
})

test('buildMcpConfigCard: refuses to save when validation fails', async () => {
  const doc = makeStubDoc()
  let committed = null
  const api = { onCommit: async (cfg) => { committed = cfg }, onClear: async () => {} }
  const tr = M.buildMcpConfigCard(doc, {
    id: 'x', name: '@deepseek-ai/dsh-mcp-client', disabled: false, source: 'user',
    config: { transport: 'stdio' }, // deliberately empty serverName + command
  }, api)
  const details = tr.children[0].children[0]
  const saveBtn = findByClass(details, 'mcp-config-save')
  // Bump one input to dirty the state.
  const nameInput = findInputByPlaceholder(details, /github, everything/)
  nameInput.value = ''
  nameInput.dispatchEvent({ type: 'input' })
  // Also dirty the command so save is unblocked from the pure-dirty check,
  // but leave serverName blank so validation trips.
  const cmdInput = findInputByPlaceholder(details, /npx, node, python/)
  cmdInput.value = 'npx'
  cmdInput.dispatchEvent({ type: 'input' })
  saveBtn.disabled = false
  await clickAndAwait(saveBtn)
  assert.equal(committed, null, 'commit should NOT fire when serverName is blank')
  const status = findByClass(details, 'mcp-config-status')
  assert.match(status.textContent, /serverName is required/)
})

// ---- tiny DOM stub -------------------------------------------------------
// Just enough to run buildMcpConfigCard end-to-end under node --test. We
// stay conservative: only the DOM surface the card touches is implemented.

function makeStubDoc() {
  return { createElement: (tag) => makeStubEl(tag) }
}
function makeStubEl(tag) {
  const listeners = new Map()
  const el = {
    tagName: tag,
    children: [],
    classList: {
      _set: new Set(),
      add: (c) => el.classList._set.add(c),
      remove: (c) => el.classList._set.delete(c),
      contains: (c) => el.classList._set.has(c),
      toggle: (c, on) => on ? el.classList.add(c) : el.classList.remove(c),
    },
    dataset: {},
    style: {},
    _events: listeners,
    appendChild(child) { this.children.push(child); child.parent = this; return child },
    insertBefore(child, ref) {
      const idx = this.children.indexOf(ref)
      if (idx < 0) this.children.push(child)
      else this.children.splice(idx, 0, child)
      child.parent = this
      return child
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(cb)
    },
    dispatchEvent(ev) {
      const cbs = listeners.get(ev.type) || []
      for (const cb of cbs) cb(ev)
    },
    setAttribute(k, v) { el[k] = v },
    getAttribute(k) { return el[k] },
    querySelector: (_sel) => null,
    querySelectorAll: (_sel) => [],
    focus() {},
    click() { el.dispatchEvent({ type: 'click' }) },
    get className() { return Array.from(this.classList._set).join(' ') },
    set className(v) {
      this.classList._set = new Set(String(v || '').split(/\s+/).filter(Boolean))
    },
  }
  // A shadow field so `el.textContent = 'x'` and `el.innerHTML = ''` both
  // work minimally; setting innerHTML to '' also clears children so the
  // list/map field repaint loops can reset the body.
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML || '' },
    set(v) { el._innerHTML = v; if (v === '') el.children.length = 0 },
  })
  Object.defineProperty(el, 'textContent', {
    get() { return el._textContent || '' },
    set(v) { el._textContent = String(v) },
  })
  return el
}
function findByClass(root, cls) {
  if (root.classList && root.classList.contains(cls)) return root
  for (const c of root.children || []) {
    const hit = findByClass(c, cls)
    if (hit) return hit
  }
  return null
}
function findInputByPlaceholder(root, re, opts = {}) {
  const stack = [root]
  while (stack.length) {
    const n = stack.shift()
    if (n.tagName === 'input' && re.test(n.placeholder || '')) return n
    for (const c of n.children || []) stack.push(c)
  }
  if (opts.optional) return null
  return null
}
async function clickAndAwait(btn) {
  btn.dispatchEvent({ type: 'click' })
  // Two microtasks to drain both the button handler and the awaited api call.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
