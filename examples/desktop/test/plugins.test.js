// Unit tests for src/main/plugins.js — the pure overlay parser + role
// template resolver. Runs under `node --test`; no Electron or fs mocking
// beyond writing into a scoped temp dir for the shell-home helpers.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const P = require('../src/main/plugins.js')

// Strip the `line` annotation parseOverlay tags each patch with so shape
// assertions can compare against the plain UI-facing patch shape. The tag is
// consumed by plugin-validation, not by consumers who write overlays back.
function stripLine(patch) {
  const { line: _line, ...rest } = patch
  return rest
}

const SAMPLE_BASE = `# example leaf
- id: mock-llm
  name: '../../deepseek-harness-dev/examples/echo-agent/src/mock-llm.ts'

- id: echo-tool
  name: '../../deepseek-harness-dev/examples/echo-agent/src/echo-tool.ts'

- id: bash
  name: '@deepseek-ai/dsh-bash-local'

- id: session-query
  name: '@deepseek-ai/dsh-session-query'

- id: daemon-agent
  name: '@deepseek-ai/dsh-daemon-demo'
  config:
    socketPath: !!js process.env.DSH_DAEMON_SOCKET_PATH
    persona: 'You are a mock daemon agent.'
`

test('parseBaseEntries pulls id/name pairs, ignores config bodies', () => {
  const entries = P.parseBaseEntries(SAMPLE_BASE)
  assert.deepEqual(entries.map((e) => e.id), [
    'mock-llm', 'echo-tool', 'bash', 'session-query', 'daemon-agent',
  ])
  assert.equal(entries.find((e) => e.id === 'bash').name, '@deepseek-ai/dsh-bash-local')
  assert.equal(entries.find((e) => e.id === 'daemon-agent').name, '@deepseek-ai/dsh-daemon-demo')
})

test('parseOverlay pulls base path and patches', () => {
  const text = `- id: base
  name: '@cordisjs/plugin-include'
  config:
    path: ../config/daemon-echo.yml
    patches:
      - id: bash
        disabled: true
      - id: my-plugin
        name: '@example/some-plugin'
        insert: append
`
  const parsed = P.parseOverlay(text)
  assert.equal(parsed.base, '../config/daemon-echo.yml')
  assert.equal(parsed.patches.length, 2)
  // parseOverlay tags patches with `line` for validator anchoring; strip it
  // for shape-equality against the shape the tab writes.
  const [p0, p1] = parsed.patches.map(stripLine)
  assert.deepEqual(p0, { id: 'bash', disabled: true })
  assert.deepEqual(p1, { id: 'my-plugin', name: '@example/some-plugin', insert: 'append' })
})

test('renderOverlay round-trips through parseOverlay', () => {
  const overlay = {
    base: '../config/daemon-echo.yml',
    patches: [
      { id: 'bash', disabled: true },
      { id: 'custom-plugin', name: '@x/plugin', insert: 'append' },
    ],
  }
  const text = P.renderOverlay(overlay)
  const reparsed = P.parseOverlay(text)
  assert.equal(reparsed.base, overlay.base)
  assert.equal(reparsed.patches.length, 2)
  assert.deepEqual(stripLine(reparsed.patches[0]), overlay.patches[0])
  assert.deepEqual(stripLine(reparsed.patches[1]), overlay.patches[1])
})

test('computeEffective folds base + patches into a UI-ready list', () => {
  const base = P.parseBaseEntries(SAMPLE_BASE)
  const patches = [
    { id: 'bash', disabled: true },
    { id: 'custom', name: '@x/custom', insert: 'append' },
  ]
  const eff = P.computeEffective(base, patches)
  assert.equal(eff.length, base.length + 1)
  const bash = eff.find((e) => e.id === 'bash')
  assert.equal(bash.disabled, true)
  assert.equal(bash.source, 'base')
  const custom = eff.find((e) => e.id === 'custom')
  assert.equal(custom.name, '@x/custom')
  assert.equal(custom.disabled, false)
  assert.equal(custom.source, 'user')
})

test('togglePatch: adds a new disabling patch when none exists', () => {
  const overlay = { base: 'x.yml', patches: [] }
  const next = P.togglePatch(overlay, 'bash', true)
  assert.equal(next.patches.length, 1)
  assert.deepEqual(next.patches[0], { id: 'bash', disabled: true })
})

test('togglePatch: updates existing patch in place', () => {
  const overlay = { base: 'x.yml', patches: [{ id: 'bash', disabled: true }] }
  const next = P.togglePatch(overlay, 'bash', true)
  assert.deepEqual(next.patches, [{ id: 'bash', disabled: true }])
})

test('togglePatch: drops an empty patch when re-enabling with no other fields', () => {
  const overlay = { base: 'x.yml', patches: [{ id: 'bash', disabled: true }] }
  const next = P.togglePatch(overlay, 'bash', false)
  assert.equal(next.patches.length, 0)
})

test('togglePatch: preserves other fields when re-enabling a user-added plugin', () => {
  const overlay = { base: 'x.yml', patches: [{ id: 'custom', name: '@x/y', insert: 'append', disabled: true }] }
  const next = P.togglePatch(overlay, 'custom', false)
  assert.equal(next.patches.length, 1)
  assert.deepEqual(next.patches[0], { id: 'custom', name: '@x/y', insert: 'append', disabled: false })
})

test('addPatch: rejects duplicates', () => {
  const overlay = { base: 'x.yml', patches: [{ id: 'a', name: '@x/a', insert: 'append' }] }
  assert.throws(() => P.addPatch(overlay, { id: 'a', name: '@x/other' }), /duplicate patch id/)
})

test('addPatch: appends a new user entry with insert default', () => {
  const overlay = { base: 'x.yml', patches: [] }
  const next = P.addPatch(overlay, { id: 'a', name: '@x/a' })
  assert.deepEqual(next.patches[0], { id: 'a', name: '@x/a', insert: 'append' })
})

test('applyRoleTemplate: coding gets no patches, research disables bash', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugins-'))
  try {
    const basePath = path.join(home, 'base.yml')
    const overlayP = path.join(home, 'overlay.yml')
    fs.writeFileSync(basePath, SAMPLE_BASE)
    const coding = P.applyRoleTemplate('coding', 'ask', basePath, overlayP)
    assert.equal(coding.overlay.patches.length, 0)
    assert.match(coding.overlay.base, /base\.yml$/)

    const research = P.applyRoleTemplate('research', 'auto', basePath, overlayP)
    assert.ok(research.overlay.patches.find((p) => p.id === 'bash' && p.disabled === true))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('applyRoleTemplate: rejects unknown role or mode', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugins-'))
  try {
    const basePath = path.join(home, 'base.yml')
    fs.writeFileSync(basePath, SAMPLE_BASE)
    assert.throws(() => P.applyRoleTemplate('bogus', 'ask', basePath, path.join(home, 'o.yml')), /unknown role/)
    assert.throws(() => P.applyRoleTemplate('coding', 'bogus', basePath, path.join(home, 'o.yml')), /unknown approval mode/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('readOverlayFile: missing file → empty overlay', () => {
  const overlay = P.readOverlayFile('/definitely/does/not/exist.yml')
  assert.deepEqual(overlay, { base: '', patches: [] })
})

test('writeOverlayFile + readOverlayFile round-trip on disk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugins-'))
  try {
    const overlayP = path.join(home, 'sub', 'user-overlay.cordis.yml')
    const overlay = { base: '../config/daemon-echo.yml', patches: [{ id: 'bash', disabled: true }] }
    P.writeOverlayFile(overlayP, overlay)
    const reread = P.readOverlayFile(overlayP)
    assert.equal(reread.base, overlay.base)
    assert.deepEqual(reread.patches.map(stripLine), overlay.patches)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('shell-home helpers respect DSH_DESKTOP_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugins-'))
  const prev = process.env.DSH_DESKTOP_HOME
  process.env.DSH_DESKTOP_HOME = home
  try {
    assert.equal(P.shellHome(), home)
    assert.equal(P.shellHomeExists(), true) // mkdtempSync created it
    P.writeShellConfig({ role: 'coding', approvalMode: 'ask', createdAt: 123 })
    assert.deepEqual(P.readShellConfig(), { role: 'coding', approvalMode: 'ask', createdAt: 123 })
  } finally {
    if (prev === undefined) delete process.env.DSH_DESKTOP_HOME
    else process.env.DSH_DESKTOP_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// A-P0-1 fix (2026-07-16): firstRun used to key off "config.json exists",
// which auto-materialized before the wizard could show, skipping onboarding
// 100% of the time. We now key off an explicit sentinel that only the
// wizard's completion path writes.
test('onboarded sentinel: fresh home has no sentinel, mark/clear flip it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-onboarded-'))
  const prev = process.env.DSH_DESKTOP_HOME
  process.env.DSH_DESKTOP_HOME = home
  try {
    // A fresh dir with no sentinel — the wizard should fire.
    assert.equal(P.onboardedSentinelExists(), false)
    // Writing config.json alone must NOT flip firstRun off.
    P.writeShellConfig({ role: 'coding', approvalMode: 'ask', createdAt: 1 })
    assert.equal(P.onboardedSentinelExists(), false,
      'writing config.json should not create the sentinel')
    // markOnboarded should create the sentinel; clearOnboarded should remove
    // it so Reset onboarding reliably re-triggers the wizard next boot.
    P.markOnboarded()
    assert.equal(P.onboardedSentinelExists(), true)
    P.clearOnboarded()
    assert.equal(P.onboardedSentinelExists(), false)
    // clearOnboarded on an already-clean home is a no-op.
    P.clearOnboarded()
    assert.equal(P.onboardedSentinelExists(), false)
  } finally {
    if (prev === undefined) delete process.env.DSH_DESKTOP_HOME
    else process.env.DSH_DESKTOP_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Task #49 (MCP frontend delivery batch, 2026-07-17): the audit at
// docs/plugin-mcp-audit.md §4 said addPatch already accepts `config`, but the
// source only carried the shape in JSDoc — parseOverlay / renderOverlay /
// addPatch all silently dropped it. These tests pin the round-trip now that
// the parser stack understands the shape.

test('parseOverlay: captures stdio mcp-client config as a shallow object', () => {
  const text = `- id: base
  name: '@cordisjs/plugin-include'
  config:
    path: ../config/daemon-echo.yml
    patches:
      - id: gh-mcp
        name: '@deepseek-ai/dsh-mcp-client'
        insert: append
        config:
          transport: "stdio"
          serverName: "github"
          command: "npx"
          args:
            - "@modelcontextprotocol/server-github"
          env:
            GITHUB_TOKEN: "ghp_fixture"
`
  const parsed = P.parseOverlay(text)
  assert.equal(parsed.patches.length, 1)
  const p = parsed.patches[0]
  assert.equal(p.id, 'gh-mcp')
  assert.equal(p.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(p.insert, 'append')
  assert.ok(p.config, 'config should be parsed')
  assert.equal(p.config.transport, 'stdio')
  assert.equal(p.config.serverName, 'github')
  assert.equal(p.config.command, 'npx')
  assert.deepEqual(p.config.args, ['@modelcontextprotocol/server-github'])
  assert.deepEqual(p.config.env, { GITHUB_TOKEN: 'ghp_fixture' })
})

test('parseOverlay: captures streamable-http mcp-client config with headers map', () => {
  const text = `- id: base
  name: '@cordisjs/plugin-include'
  config:
    path: base.yml
    patches:
      - id: http-mcp
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          transport: "streamable-http"
          serverName: "grafana"
          url: "https://mcp.example.com/rpc"
          headers:
            Authorization: "Bearer secret"
            X-Trace-Id: "abc123"
`
  const parsed = P.parseOverlay(text)
  const p = parsed.patches[0]
  assert.equal(p.config.transport, 'streamable-http')
  assert.equal(p.config.serverName, 'grafana')
  assert.equal(p.config.url, 'https://mcp.example.com/rpc')
  assert.deepEqual(p.config.headers, {
    Authorization: 'Bearer secret',
    'X-Trace-Id': 'abc123',
  })
})

test('parseOverlay: config-body flush does not swallow following patch', () => {
  const text = `- id: base
  name: '@cordisjs/plugin-include'
  config:
    path: base.yml
    patches:
      - id: first
        name: '@x/first'
        config:
          key: "value"
      - id: second
        name: '@x/second'
        disabled: true
`
  const parsed = P.parseOverlay(text)
  assert.equal(parsed.patches.length, 2)
  assert.equal(parsed.patches[0].id, 'first')
  assert.deepEqual(parsed.patches[0].config, { key: 'value' })
  assert.equal(parsed.patches[1].id, 'second')
  assert.equal(parsed.patches[1].disabled, true)
})

test('renderOverlay: emits nested config with env/args nested blocks', () => {
  const overlay = {
    base: 'base.yml',
    patches: [{
      id: 'gh-mcp',
      name: '@deepseek-ai/dsh-mcp-client',
      insert: 'append',
      config: {
        transport: 'stdio',
        serverName: 'github',
        command: 'npx',
        args: ['@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_fixture' },
      },
    }],
  }
  const text = P.renderOverlay(overlay)
  assert.match(text, /transport: "stdio"/)
  assert.match(text, /serverName: "github"/)
  assert.match(text, /args:\n {12}- "@modelcontextprotocol\/server-github"/)
  assert.match(text, /env:\n {12}GITHUB_TOKEN: "ghp_fixture"/)
})

test('renderOverlay + parseOverlay round-trip: mcp-client config survives', () => {
  const overlay = {
    base: 'base.yml',
    patches: [
      { id: 'bash', disabled: true },
      {
        id: 'gh-mcp',
        name: '@deepseek-ai/dsh-mcp-client',
        insert: 'append',
        config: {
          transport: 'stdio',
          serverName: 'github',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_x' },
        },
      },
      {
        id: 'http-mcp',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          transport: 'streamable-http',
          serverName: 'grafana',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer x' },
        },
      },
    ],
  }
  const text = P.renderOverlay(overlay)
  const reparsed = P.parseOverlay(text)
  assert.equal(reparsed.patches.length, 3)
  assert.equal(reparsed.patches[0].disabled, true)
  const gh = reparsed.patches.find((p) => p.id === 'gh-mcp')
  assert.deepEqual(gh.config.args, ['-y', '@modelcontextprotocol/server-github'])
  assert.deepEqual(gh.config.env, { GITHUB_TOKEN: 'ghp_x' })
  const http = reparsed.patches.find((p) => p.id === 'http-mcp')
  assert.deepEqual(http.config.headers, { Authorization: 'Bearer x' })
})

test('addPatch: accepts a config sub-object and preserves it', () => {
  const overlay = { base: 'x.yml', patches: [] }
  const next = P.addPatch(overlay, {
    id: 'gh-mcp',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { transport: 'stdio', serverName: 'github' },
  })
  assert.deepEqual(next.patches[0].config, { transport: 'stdio', serverName: 'github' })
})

test('setPatchConfig: seeds a fresh patch when the row has no patch yet', () => {
  const overlay = { base: 'x.yml', patches: [] }
  const next = P.setPatchConfig(overlay, 'mcp-client', {
    transport: 'stdio', serverName: 'github',
  })
  assert.equal(next.patches.length, 1)
  assert.equal(next.patches[0].id, 'mcp-client')
  assert.deepEqual(next.patches[0].config, { transport: 'stdio', serverName: 'github' })
})

test('setPatchConfig: overwrites existing config in place', () => {
  const overlay = { base: 'x.yml', patches: [{
    id: 'mcp-client', name: '@deepseek-ai/dsh-mcp-client',
    config: { transport: 'stdio', serverName: 'old' },
  }] }
  const next = P.setPatchConfig(overlay, 'mcp-client', {
    transport: 'streamable-http', serverName: 'new', url: 'https://x/y',
  })
  assert.equal(next.patches.length, 1)
  assert.deepEqual(next.patches[0].config, {
    transport: 'streamable-http', serverName: 'new', url: 'https://x/y',
  })
  assert.equal(next.patches[0].name, '@deepseek-ai/dsh-mcp-client')
})

test('setPatchConfig: clearing config drops a patch that carries nothing else', () => {
  const overlay = { base: 'x.yml', patches: [{
    id: 'seeded', config: { serverName: 'x' },
  }] }
  const next = P.setPatchConfig(overlay, 'seeded', null)
  assert.equal(next.patches.length, 0)
})

test('setPatchConfig: clearing keeps a patch that has other fields', () => {
  const overlay = { base: 'x.yml', patches: [{
    id: 'x', disabled: true, config: { k: 'v' },
  }] }
  const next = P.setPatchConfig(overlay, 'x', null)
  assert.equal(next.patches.length, 1)
  assert.equal(next.patches[0].disabled, true)
  assert.ok(!next.patches[0].config)
})

test('togglePatch: re-enabling a config-only patch keeps the patch (config not lost)', () => {
  const overlay = { base: 'x.yml', patches: [{
    id: 'mcp-client', disabled: true, config: { serverName: 'gh' },
  }] }
  const next = P.togglePatch(overlay, 'mcp-client', false)
  assert.equal(next.patches.length, 1)
  assert.equal(next.patches[0].disabled, false)
  assert.deepEqual(next.patches[0].config, { serverName: 'gh' })
})

test('computeEffective: surfaces config on the user row for the plugin UI', () => {
  const base = P.parseBaseEntries(SAMPLE_BASE)
  const patches = [
    { id: 'gh-mcp', name: '@deepseek-ai/dsh-mcp-client',
      config: { transport: 'stdio', serverName: 'github' } },
  ]
  const eff = P.computeEffective(base, patches)
  const row = eff.find((e) => e.id === 'gh-mcp')
  assert.ok(row)
  assert.equal(row.source, 'user')
  assert.deepEqual(row.config, { transport: 'stdio', serverName: 'github' })
})
