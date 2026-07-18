// Default profile: stdio-deepseek (2026-07-18 user directive)
//
// Team-lead single-line brief: 「默认档改为真模型档」. New downloaders should
// see a working DeepSeek reply on first send, not the echo bot. Persisted
// picks from prior sessions win over this default (readShellConfig().profile).
// Missing key → runtime dies with `llm-deepseek: an API key is required` in
// stderr; main.js accumulates stderr, matches the signature on crash, and
// forwards via runtime:error so classifyRuntimeError can render the guided
// switch card (locked separately in renderer-runtime-banner-classify.test.js).
//
// The tests below lock:
//   (1) main.js has the new stdio-deepseek default at the module-scope var,
//   (2) the boot-selection block reads shellConfig.profile before falling
//       back to the default (so we don't stomp a persisted pick),
//   (3) runtime:start persists the user's manual pick via writeShellConfig,
//   (4) the crash handler in main.js forwards the api-key signature into
//       runtime:error so the renderer's classifier can pick it up,
//   (5) profiles.js/stdio-deepseek still carries the (needs DEEPSEEK_API_KEY)
//       label — the settings/status-bar copy fans out from this one string.
//
// Static-audit pattern (regex-over-source), same shape as
// renderer-runtime-banner-classify.test.js. Real cold-start with/without a
// key is exercised in the interactive sweep v2 on real hardware.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MAIN_PATH = path.join(__dirname, '..', 'src', 'main', 'main.js')
const PROFILES_PATH = path.join(__dirname, '..', 'src', 'main', 'profiles.js')

test('default profile is stdio-deepseek at module scope', () => {
  const src = fs.readFileSync(MAIN_PATH, 'utf8')
  // The `let currentProfileName = '<name>'` declaration must name
  // stdio-deepseek. Regex is anchored to the exact assignment site so a
  // rename or a stray shadowing declaration would fail loudly.
  assert.match(
    src,
    /let\s+currentProfileName\s*=\s*'stdio-deepseek'/,
    'currentProfileName must default to stdio-deepseek — the boss call is to aim first-run at the real model',
  )
  // Belt-and-suspenders: the OLD `daemon-echo` default must not survive as
  // the module-scope initializer. Any reference inside comments/strings
  // elsewhere is fine — only the `let currentProfileName = 'daemon-echo'`
  // shape is banned.
  assert.doesNotMatch(
    src,
    /let\s+currentProfileName\s*=\s*'daemon-echo'/,
    'old daemon-echo default must not resurface as the module-scope initializer',
  )
})

test('boot selects persisted profile first, stdio-deepseek fallback second', () => {
  const src = fs.readFileSync(MAIN_PATH, 'utf8')
  // The auto-start block must (a) read shellConfig, (b) prefer cfg.profile
  // when the id is in listProfiles(), and (c) fall back to 'stdio-deepseek'
  // as the boot target. Order matters — a persisted pick must win.
  const idx = src.indexOf('bootProfile')
  assert.notEqual(idx, -1, 'bootProfile selection missing from boot block')
  const window = src.slice(Math.max(0, idx - 800), idx + 1200)
  assert.match(window, /P\.readShellConfig\(\)/, 'must read shellConfig to honor a persisted pick')
  assert.match(window, /cfg\.profile/, 'must consult cfg.profile as the persisted key')
  assert.match(window, /listProfiles\(\)/, 'must validate persisted pick against listProfiles')
  assert.match(window, /'stdio-deepseek'/, 'stdio-deepseek must be the fallback default in the boot block')
  assert.match(window, /await startRuntime\(bootProfile\)/, 'startRuntime must be called with the selected bootProfile')
})

test('boot fallback on hard error goes to stdio-echo (keyless, no dev-clone required beyond jsonrpcBin)', () => {
  const src = fs.readFileSync(MAIN_PATH, 'utf8')
  // Kernel-level failures (spawn ENOENT, dev-clone missing) still land the
  // shell on stdio-echo so the UI isn't dead. The api-key case does NOT
  // hit this branch — the runtime spawns successfully, then dies during
  // plugin init; the crash handler surfaces the classified error instead.
  const idx = src.indexOf('boot failed, falling back to stdio-echo')
  assert.notEqual(idx, -1, 'boot fallback message missing from main.js')
  const window = src.slice(idx, idx + 400)
  assert.match(window, /startRuntime\('stdio-echo'\)/, 'boot fallback must target stdio-echo')
})

test('runtime:start persists the user pick into shellConfig.profile', () => {
  const src = fs.readFileSync(MAIN_PATH, 'utf8')
  // The runtime:start handler must merge the picked name into shellConfig
  // so next boot honors the pick. Best-effort — a fs failure must never
  // block the runtime start itself.
  const idx = src.indexOf(`ipcMain.handle('runtime:start'`)
  assert.notEqual(idx, -1, 'runtime:start handler not found')
  const body = src.slice(idx, idx + 800)
  assert.match(body, /P\.writeShellConfig\(/, 'runtime:start must call writeShellConfig to persist')
  assert.match(body, /profile:\s*name/, 'the persisted config must carry profile: name')
  // Must guard the persistence so a fs error is non-fatal (try/catch or
  // .catch on the fs promise — accept either shape).
  assert.ok(
    /try\s*{[\s\S]{0,400}writeShellConfig/.test(body),
    'profile persistence must be inside try/catch to stay non-fatal',
  )
})

test('crash handler forwards missing-api-key stderr signature to runtime:error', () => {
  const src = fs.readFileSync(MAIN_PATH, 'utf8')
  // The stderr accumulator + crash handler wiring — needed because
  // llm-deepseek's key error surfaces on stderr, not via protocolError,
  // and stderr is DSH_DEBUG-gated in the renderer. Regex scans for the
  // named accumulator + the api-key signature + the runtime:error send.
  const idx = src.indexOf('stderrAccum')
  assert.notEqual(idx, -1, 'stderrAccum ledger missing — key error would not reach the banner')
  // Widened window (2026-07-18, fix/harness-dev-guard): the crash handler
  // gained a full-stderr log-file flush + a separate stderrFull
  // accumulator between the declaration and the supervisor.on('stderr')
  // wire. The original 2500-char window was tight; 4500 covers the
  // expanded block while still failing if the wire actually moves out.
  const window = src.slice(idx, idx + 4500)
  assert.match(window, /supervisor\.on\('stderr'/, 'stderr accumulator must live inside a supervisor.on(stderr) handler wire')
  assert.match(window, /API key is required/i, 'api-key signature must be matched in the crash handler')
  assert.match(window, /send\('runtime:error'/, 'matched signature must be forwarded via runtime:error so classify can bucket it')
})

test('stdio-deepseek profile keeps the (needs DEEPSEEK_API_KEY) label', () => {
  const src = fs.readFileSync(PROFILES_PATH, 'utf8')
  // The dropdown, status bar chip, and settings pane all render this
  // label. Locking here means a rename triggers a real trace of downstream
  // UI copy (Settings copy, status-bar tooltip) rather than a silent drift.
  assert.match(
    src,
    /stdio-deepseek[\s\S]{0,600}needs DEEPSEEK_API_KEY/,
    'stdio-deepseek label must advertise the DEEPSEEK_API_KEY dependency',
  )
})
