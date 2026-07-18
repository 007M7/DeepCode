// The QA-only `window:reveal` handler is extracted into window-reveal.js so
// we can drive its handshake without booting Electron. The channel itself
// is registered by src/main/main.js only when process.env.DSH_QA === '1' —
// that gate is asserted here by a smaller check that reads the source, so
// the production preload never leaks the reveal seam.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { revealWindow } = require('../src/main/window-reveal.js')

function fakeWindow(overrides = {}) {
  const state = { shown: false, workspaceCalls: [], destroyed: false }
  const win = {
    isDestroyed: () => state.destroyed,
    isVisibleOnAllWorkspaces: () => false,
    setVisibleOnAllWorkspaces: (flag, opts) => state.workspaceCalls.push({ flag, opts }),
    showInactive: () => { state.shown = true },
    ...overrides,
  }
  win._state = state
  return win
}

test('reveal returns no-window when handle is missing', async () => {
  const res1 = await revealWindow(null)
  assert.deepStrictEqual(res1, { ok: false, reason: 'no-window' })
  const dead = fakeWindow()
  dead._state.destroyed = true
  const res2 = await revealWindow(dead)
  assert.deepStrictEqual(res2, { ok: false, reason: 'no-window' })
})

test('reveal calls showInactive on a healthy window', async () => {
  const w = fakeWindow()
  const res = await revealWindow(w, { platform: 'linux', sleep: () => Promise.resolve() })
  assert.deepStrictEqual(res, { ok: true })
  assert.strictEqual(w._state.shown, true, 'showInactive must fire — the whole point of the seam')
})

test('darwin path flips workspace flag on then restores off', async () => {
  const w = fakeWindow()
  await revealWindow(w, { platform: 'darwin', sleep: () => Promise.resolve() })
  assert.ok(w._state.workspaceCalls.length >= 2,
    `expected at least two workspace-flag calls on darwin (got ${w._state.workspaceCalls.length})`)
  assert.strictEqual(w._state.workspaceCalls[0].flag, true)
  assert.deepStrictEqual(w._state.workspaceCalls[0].opts, { visibleOnFullScreen: false })
  const last = w._state.workspaceCalls[w._state.workspaceCalls.length - 1]
  assert.strictEqual(last.flag, false,
    'must restore to false — otherwise the window follows the user across every Space')
})

test('non-darwin platforms skip the workspace flip entirely', async () => {
  const w = fakeWindow()
  await revealWindow(w, { platform: 'linux', sleep: () => Promise.resolve() })
  assert.strictEqual(w._state.workspaceCalls.length, 0,
    'workspace-flag is a macOS Space quirk; other platforms should never touch it')
})

test('darwin: if window already visibleOnAllWorkspaces, do NOT force it back to false', async () => {
  // Some users legitimately keep DSH on all workspaces themselves. Our
  // reveal must not override that preference on exit.
  const w = fakeWindow({ isVisibleOnAllWorkspaces: () => true })
  await revealWindow(w, { platform: 'darwin', sleep: () => Promise.resolve() })
  // We may have called setVisibleOnAllWorkspaces(true, …) again (redundant but harmless),
  // but must NOT have called false on the way out.
  const restoredFalse = w._state.workspaceCalls.some((c) => c.flag === false)
  assert.strictEqual(restoredFalse, false,
    'we should not clobber a user-set all-workspaces preference')
})

test('main.js gates window:reveal registration on DSH_QA=1', () => {
  // Source-level assertion — the seam must be behind an explicit env flag
  // so the production preload surface has zero reveal channel. Reading
  // the source keeps the test cheap and honest about main.js's structure
  // (we don't boot Electron just to sniff a handler registration).
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  const registerIdx = src.indexOf("ipcMain.handle('window:reveal'")
  assert.notStrictEqual(registerIdx, -1, 'window:reveal handler registration missing from main.js')
  // The NEAREST gate before the handler must be the DSH_QA=1 check — other
  // earlier DSH_QA gates (qa hash, console mirror) are unrelated to this seam.
  const gateIdx = src.lastIndexOf("process.env.DSH_QA === '1'", registerIdx)
  assert.notStrictEqual(gateIdx, -1, 'DSH_QA gate string missing before window:reveal in main.js')
  assert.ok(registerIdx < gateIdx + 400,
    'window:reveal handler must be inside the DSH_QA=1 gate block')
})

test('preload.js exposes dshQa.revealWindow only when DSH_QA=1', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8')
  const gateIdx = src.indexOf("process.env.DSH_QA === '1'")
  const bridgeIdx = src.indexOf("exposeInMainWorld('dshQa'")
  assert.notStrictEqual(gateIdx, -1, 'DSH_QA gate missing from preload.js')
  assert.notStrictEqual(bridgeIdx, -1, 'dshQa contextBridge missing from preload.js')
  assert.ok(bridgeIdx > gateIdx,
    'dshQa bridge must sit inside the DSH_QA=1 gate block')
})
