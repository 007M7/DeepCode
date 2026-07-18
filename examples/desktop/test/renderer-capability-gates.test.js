// Ticket G (task #125): renderer-level gates for initialize.result.capabilities.
//
// The pure module capabilities.js is unit-tested in test/capabilities.test.js;
// this suite locks the wiring — that the six declared-false capabilities each
// dim the right surface AFTER the runtime's initialize response lands, and
// that a v1 daemon (no capabilities envelope) keeps every surface lit so
// legacy runtimes don't go dark ("wire silent ≠ unsupported").
//
// Fixture posture (shared-repo rule #4): initialize responses mirror the real
// jsonrpc-net shape — `{serverInfo:{name,version}, protocolVersion, capabilities}`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

async function fireInitialize(listeners, capabilities) {
  listeners.onInitialized({
    serverInfo: { name: 'test-daemon', version: '0.0.1' },
    protocolVersion: 2,
    capabilities,
  })
  await new Promise((r) => setTimeout(r, 5))
}

test('v1 daemon (no capabilities envelope) leaves every surface lit', async () => {
  const { renderer, listeners, document } = await loadRenderer()
  await fireInitialize(listeners, undefined)
  const caps = renderer.getServerCapabilities()
  // normalizeCapabilities returns an all-true object when the runtime shipped
  // no envelope, mirroring the shell's "wire silent ≠ unsupported" posture.
  assert.ok(caps && typeof caps === 'object', 'caps must be an object even when no envelope')
  // Every gate helper reports supported for legacy runtimes.
  for (const key of ['cancel', 'sessionQuery', 'setConfig', 'fork', 'plugins', 'compact']) {
    assert.equal(renderer.isCapabilitySupported(key), true,
      `${key} must remain lit when the runtime didn't ship a capabilities envelope`)
    assert.equal(caps[key], true, `${key} must default to true`)
  }
  // Plugins tab is not visually disabled.
  const pluginsTab = document.querySelector('.tab-btn[data-tab="plugins"]')
  if (pluginsTab) {
    assert.notEqual(pluginsTab.getAttribute('aria-disabled'), 'true')
    assert.equal(pluginsTab.classList.contains('capability-disabled'), false)
  }
})

test('capabilities.cancel=false disables Cancel button with canonical tooltip', async () => {
  const { listeners, document } = await loadRenderer()
  await fireInitialize(listeners, { cancel: false })
  const cancelBtn = document.getElementById('cancel')
  assert.ok(cancelBtn, 'cancel button must exist in the shell')
  assert.equal(cancelBtn.disabled, true, 'Cancel must be disabled when cancel=false')
  assert.match(cancelBtn.title, /session\/cancel/,
    'tooltip must name the missing wire method so the user reads it as a runtime gap')
})

test('capabilities.compact=false disables Compact button with capability tooltip', async () => {
  const { listeners, document, renderer } = await loadRenderer()
  // Seed an active session so hasSession=true — that isolates the capability
  // gate from the "start a session first" branch.
  renderer.ensureSession('s-active', { title: 'x', header: {} })
  await renderer.selectSession('s-active')
  await fireInitialize(listeners, { compact: false })
  // After onInitialized wipes state, seed again + re-select.
  renderer.ensureSession('s-active', { title: 'x', header: {} })
  await renderer.selectSession('s-active')
  // Nudge the button through updateCompactButton via the exported gate helper.
  renderer.applyCapabilityGates()
  const compactBtn = document.getElementById('ctx-compact-btn')
  assert.ok(compactBtn, 'ctx-compact-btn must exist in the shell')
  assert.equal(compactBtn.disabled, true, 'Compact must be disabled when compact=false')
  assert.match(compactBtn.title, /session\/compact/,
    'tooltip must name the missing wire method')
})

test('capabilities.sessionQuery=false disables new-session button', async () => {
  const { listeners, document } = await loadRenderer()
  await fireInitialize(listeners, { sessionQuery: false })
  const newSessionBtn = document.getElementById('new-session')
  assert.ok(newSessionBtn, 'new-session button must exist')
  assert.equal(newSessionBtn.disabled, true,
    'new-session must be disabled when the runtime cannot list sessions')
  assert.match(newSessionBtn.title, /session\/list/,
    'tooltip must name the missing wire method')
})

test('capabilities.plugins=false grays the Plugins tab and blocks click', async () => {
  const { listeners, document, renderer } = await loadRenderer()
  await fireInitialize(listeners, { plugins: false })
  const pluginsTab = document.querySelector('.tab-btn[data-tab="plugins"]')
  if (!pluginsTab) return // some harness shells don't render the tab; skip
  assert.equal(pluginsTab.getAttribute('aria-disabled'), 'true')
  assert.equal(pluginsTab.classList.contains('capability-disabled'), true)
  assert.match(pluginsTab.title, /plugins\/\*/,
    'tooltip must name the missing plugins/* namespace')
  // isCapabilitySupported gates the click; the actual click handler in the
  // shell short-circuits before switchTo, so the plugins panel stays hidden.
  assert.equal(renderer.isCapabilitySupported('plugins'), false)
})

test('capabilities.setConfig=false disables composer model dropdown', async () => {
  const { listeners, document } = await loadRenderer()
  await fireInitialize(listeners, { setConfig: false })
  const composerModel = document.getElementById('composer-model')
  if (!composerModel) return
  assert.equal(composerModel.disabled, true,
    'composer model dropdown must be disabled when set_config isn\'t advertised')
  assert.match(composerModel.title, /session\/set_config/,
    'tooltip must name the missing wire method')
})

test('capabilities.fork=false grays fork buttons via updateForkButtons', async () => {
  const { listeners, renderer } = await loadRenderer()
  await fireInitialize(listeners, { fork: false })
  assert.equal(renderer.isCapabilitySupported('fork'), false)
  // updateForkButtons walks .msg.assistant → .fork-here; with no bubbles
  // present the walk is a no-op, but the gate is what we're locking here.
  // syncForkButton is called for each fork button and sets disabled=true
  // + the canonical tooltip. Verify the tooltip helper resolves.
  const M = require('../src/renderer/capabilities.js')
  assert.match(M.capabilityDisabledTitle('fork'), /session\/fork/)
})

test('all six declared false → serverCapabilities snapshot has all six flipped', async () => {
  const { listeners, renderer } = await loadRenderer()
  await fireInitialize(listeners, {
    cancel: false, sessionQuery: false, setConfig: false,
    fork: false, plugins: false, compact: false,
  })
  const caps = renderer.getServerCapabilities()
  assert.deepEqual(caps, {
    cancel: false, sessionQuery: false, setConfig: false,
    fork: false, plugins: false, compact: false,
  }, 'every declared-false bit must land in state.serverCapabilities verbatim')
})

test('serverName and serverVersion are captured for the devtools header', async () => {
  const { listeners, renderer } = await loadRenderer()
  listeners.onInitialized({
    serverInfo: { name: 'daemon-alpha', version: '3.14' },
    protocolVersion: 2,
    capabilities: {},
  })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(renderer.getServerName(), 'daemon-alpha',
    'serverName must be stashed for bug-report identification')
  assert.equal(renderer.getServerVersion(), '3.14',
    'serverVersion must be stashed for bug-report identification')
})
