// Electron main process. Owns the BrowserWindow, the RuntimeSupervisor, the
// interrupt-resolver map, and the IPC surface exposed via preload. The
// renderer never talks to the runtime directly — everything flows through
// here so we can swap stdio for socket without changing UI code.

'use strict'

const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { RuntimeSupervisor } = require('./runtime.js')
const { profile, listProfiles, modelsFor, preflightRuntimeBinaries } = require('./profiles.js')
const P = require('./plugins.js')
const V = require('./plugin-validation.js')
const H = require('./plugin-heuristics.js')
const M = require('./plugin-market.js')
const GH = require('./gh-prs.js')
const Growth = require('./growth-log.js')
const GrowthV2 = require('./growth-v2.js')
const { normalizeInterruptRequest } = require('./interrupt-normalize.js')
const { classifyForkErrorMessage } = require('./fork-error-classify.js')
const { revealWindow } = require('./window-reveal.js')
// Artifact preview lane (RFC 2026-07-13). Kept in its own module so the demo
// shell only adds a card entry point + a localhost server; it never embeds a
// webview. See src/main/artifact-server.js + artifact-ipc.js.
const artifactIpc = require('./artifact-ipc.js')
// Runtime-stderr log writer (2026-07-18, fix/harness-dev-guard). Persists the
// full stderr transcript to <userData>/logs/runtime-stderr.log on crash so
// silent-exit failures (spawn ENOENT, schema drift, plugin-load rejections)
// are diagnosable without launching devtools.
const { writeRuntimeStderrLog, runtimeStderrLogPath } = require('./runtime-stderr-log.js')
// Hub page (#186 + #190). The seven-kind asset catalog + local script runner.
// Keeps its own module because file IO + child-process spawning are unrelated
// to the daemon supervisor and the marketing plugins-tab wiring.
const HubAssets = require('./hub-assets.js')

let win = null
let supervisor = null
// Default profile (2026-07-18 user directive, boss call): first-run should
// aim at the real model, not the mock. New downloaders overwhelmingly want to
// see a working DeepSeek reply, not "here's an echo bot". If they don't have
// DEEPSEEK_API_KEY the classifyRuntimeError missing-api-key path surfaces a
// guided switch card offering daemon-echo instead. Persisted picks from an
// earlier session win over this default via readShellConfig().profile below.
let currentProfileName = 'stdio-deepseek'
// Pending interrupts the runtime asked us about. Correlated by interruptId
// (falls back to the JSON-RPC request id when the wire omits one). The
// renderer resolves each via IPC.
const pendingInterrupts = new Map() // interruptId -> { resolve, sessionId }

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function onInterrupt(request) {
  // Canonical protocol v2 shape (impl-interact, authoritative — see
  // on the integration
  // branch, and the wire sample recorded in INTEGRATION-REPORT.md's
  // "Approval passthrough" section):
  //   { sessionId, interruptId, payload: { kind:'approval'|'form', spec:{...} } }
  // A prior draft used a flat `request.spec.kind` — that branch never made
  // it to the wire; the bridge only ever emits `payload.kind`. Anything
  // else answers fail-closed (cancelled); test/interrupt-normalize.test.js
  // locks the accept/reject matrix. Normalizer lives in
  // ./interrupt-normalize.js so tests can exercise it without booting
  // Electron.
  return normalizeInterruptRequest(request, pendingInterrupts, (channel, data) => send(channel, data))
}

async function startRuntime(name) {
  if (supervisor) {
    await supervisor.stop().catch(() => {})
    supervisor = null
  }
  // Any interrupt from the old runtime is now unresolvable — resolve them
  // as cancelled so the UI doesn't leak stale cards.
  for (const [id, entry] of pendingInterrupts) {
    entry.resolve({ outcome: 'cancelled' })
    send('interrupt:invalidate', { interruptId: id, reason: 'runtime restarting' })
  }
  pendingInterrupts.clear()

  currentProfileName = name
  // HARNESS_DEV phantom-path preflight (2026-07-18, fix/harness-dev-guard).
  // profiles.js resolves the runtime SDK against __dirname; when the shell
  // boots from a worktree that has no sibling `deepseek-harness-dev/`, that
  // resolves to a nonexistent path and spawn dies with an ENOENT + empty
  // stderr — the renderer used to misclassify that as "Runtime file missing"
  // (pointing at profile leaves, wrong hint). Fail loud here with a clear
  // message before we even build the supervisor. The classifier still has a
  // dedicated bucket for real spawn-ENOENT (defense in depth) but this path
  // lets us surface the actionable text without needing any stderr at all.
  try {
    preflightRuntimeBinaries(name)
  } catch (err) {
    send('runtime:error', { message: err.message })
    // Rethrow so the runtime:start IPC handler resolves with `{ ok: false }`
    // rather than falsely claiming the runtime is up.
    throw err
  }
  const p = profile(name)
  p.onInterrupt = onInterrupt
  supervisor = new RuntimeSupervisor({ profile: p })
  supervisor.on('status', (s) => send('runtime:status', {
    status: s,
    profile: name,
    model: p.model,
    // Preflight (2026-07-18) NO_ADAPTER guard: renderer needs the profile's
    // supported-models list to filter the composer dropdown. Sourced from
    // profiles.js:PROFILE_MODELS which mirrors each yml leaf's `models:`
    // block (the daemon's real registry).
    supportedModels: modelsFor(name),
  }))
  supervisor.on('notify', (method, params) => {
    send('runtime:notify', { method, params })
    // Artifact detection: tool/result events with a file path inside the
    // artifact dir become cards in the stream. Fire-and-forget — this must
    // never block the notify pipeline or throw into the supervisor.
    if (method === 'session.event' && params && params.event) {
      void artifactIpc.inspectSessionEvent(params.event).catch(() => {})
    }
  })
  // Missing-key surfacing (2026-07-18): when the default profile is
  // stdio-deepseek and the user has no DEEPSEEK_API_KEY, llm-deepseek
  // throws during plugin load and the runtime process dies before
  // initialize completes. `protocolError` fires with a bland "socket hang
  // up" — the real message is in stderr, which we route through
  // `runtime:stderr` (debug-gated) and console only. Accumulate a small
  // stderr tail; on crash, scan it for the api-key signature and forward
  // via `runtime:error` so classifyRuntimeError can render the guided
  // switch card. Not-matched crashes fall through to the existing
  // stderrTail path (console.error only) — unchanged.
  let stderrAccum = ''
  const STDERR_ACCUM_CAP = 8 * 1024 // keep the tail small; only need the signature
  // Full stderr transcript (uncapped) for the log file. See
  // runtime-stderr-log.js: STDERR_ACCUM_CAP is deliberately tiny for the
  // signature-scan path, but a full stack trace needs the whole capture.
  // Bounded only by process memory — resets on each new startRuntime.
  let stderrFull = ''
  const STDERR_FULL_CAP = 512 * 1024 // 512KB hard cap so a runaway logger can't OOM the shell
  function flushStderrLogFile(reason, info) {
    try {
      const userDataDir = app.getPath('userData')
      const tail = (info && typeof info.stderrTail === 'string' ? info.stderrTail : '')
      // Prefer the fuller accumulator; fall back to the transport-side tail
      // for edge cases where the 'stderr' event didn't fire (spawnError
      // before any output).
      const body = stderrFull || tail
      return writeRuntimeStderrLog({
        userDataDir,
        stderr: body,
        meta: {
          profile: currentProfileName,
          reason,
          exitCode: info && 'code' in info ? info.code : undefined,
          signal: info && 'signal' in info ? info.signal : undefined,
        },
      })
    } catch (_err) {
      // Best-effort only — don't amplify the original crash.
      return null
    }
  }
  supervisor.on('crash', (info) => {
    for (const [id, entry] of pendingInterrupts) {
      entry.resolve({ outcome: 'cancelled' })
      send('interrupt:invalidate', { interruptId: id, reason: 'runtime crashed' })
    }
    pendingInterrupts.clear()
    send('runtime:crash', info)
    // Persist the full stderr transcript before anything else — the banner
    // hint below quotes the log path, and QA needs the file even for the
    // silent-exit / no-classification case.
    const logPath = flushStderrLogFile('runtime crash', info)
    const tail = (info && typeof info.stderrTail === 'string' ? info.stderrTail : '') + stderrAccum
    if (/llm-deepseek:\s*an API key is required|API key is required.*DEEPSEEK_API_KEY|DEEPSEEK_API_KEY.*required/i.test(tail)) {
      // Extract the first matching line so the banner Details pane has a
      // clean quote. Fall back to the whole tail if the regex tag doesn't
      // fire on any single line.
      const line = tail.split(/\r?\n/).find((l) => /api key is required/i.test(l)) || 'llm-deepseek: an API key is required'
      send('runtime:error', { message: line })
    } else if (info && info.code !== 0 && logPath) {
      // Silent-exit fallback: unclassified non-zero exit. Surface the log
      // path via runtime:error so the banner's details pane names it. Only
      // fires when the api-key regex didn't already match — that path has
      // its own richer message.
      send('runtime:error', { message: `runtime exited (code=${info.code}); see ${logPath} for full stderr` })
    }
    stderrAccum = ''
    stderrFull = ''
  })
  supervisor.on('stderr', (chunk) => {
    send('runtime:stderr', chunk)
    const s = String(chunk)
    stderrAccum = (stderrAccum + s).slice(-STDERR_ACCUM_CAP)
    stderrFull = (stderrFull + s).slice(-STDERR_FULL_CAP)
  })
  supervisor.on('protocolError', (err) => {
    // spawn ENOENT surfaces here as a protocolError with the raw
    // `spawn <path> ENOENT` message. The classifier's new bucket catches
    // that shape and points at DSH_DEV_ROOT. Also flush the log so the
    // fuller stderr (if any) is on disk before the banner appears.
    flushStderrLogFile('protocol error', { code: null, signal: null })
    send('runtime:error', { message: err.message })
  })
  supervisor.on('initialized', (info) => send('runtime:initialized', info))
  await supervisor.start()
}

function createWindow() {
  // Windows/Linux window chrome + taskbar icon. macOS ignores the `icon` option
  // and takes its dock icon from `app.dock.setIcon`, which we wire below once
  // the app is ready. Silent try/catch: a missing asset shouldn't block boot.
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'logo.png')
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#ffffff',
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  })
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(iconPath) } catch (_) { /* non-fatal */ }
  }
  // Opt-in maximize for demo recording. Gated on an env var so this stays
  // invisible to every non-recording run — the boss's showcase driver sets
  // DSH_MAXIMIZE=1, everybody else keeps the fixed 1200×800 baseline.
  if (process.env.DSH_MAXIMIZE === '1') {
    try { win.maximize() } catch (_) { /* non-fatal */ }
  }
  // DSH_QA=1 forwards a `qa` URL hash to the renderer so src/renderer/qa-harness.js
  // wakes up. Normal launches send no hash — harness stays inert.
  const qaHash = process.env.DSH_QA === '1' ? { hash: 'qa' } : undefined
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), qaHash)
  // Log renderer console into main-process stdout so headless QA runs can
  // capture QA_SUMMARY / QA_REPORT_JSON lines without opening devtools.
  if (process.env.DSH_QA === '1') {
    win.webContents.on('console-message', (_e, _level, message, line, source) => {
      process.stdout.write(`[renderer] ${source}:${line} ${message}\n`)
    })
  }
}

app.whenReady().then(async () => {
  createWindow()
  // Register the global "Quick chat" shortcut. ⌘⇧Space on macOS, Ctrl+Shift+
  // Space elsewhere. If the OS refuses the binding (already claimed by
  // something else), we log and continue — the in-app header button still
  // works, and the shortcut is not load-bearing for any test.
  try {
    const accel = process.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space'
    const ok = globalShortcut.register(accel, () => send('quickchat:toggle', {}))
    if (!ok) console.warn(`globalShortcut ${accel} refused by OS`)
  } catch (err) {
    console.warn('globalShortcut registration failed:', err.message)
  }
  // Artifact IPC (see artifact-ipc.js). Registered before startRuntime so the
  // first tool/result → inspectSessionEvent path already has handlers wired.
  artifactIpc.registerArtifactIpc()

  // QA-only window-reveal seam. Registered *only* when DSH_QA=1 so the
  // production preload surface has zero extra IPC. The reveal handshake
  // (showInactive + darwin workspace flag flip/restore) lives in
  // ./window-reveal.js so it can be unit-tested without booting Electron.
  if (process.env.DSH_QA === '1') {
    ipcMain.handle('window:reveal', () => revealWindow(win))
  }

  ipcMain.handle('profiles:list', () => listProfiles().map((n) => ({ id: n, label: profile(n).label })))
  // Preflight (2026-07-18) NO_ADAPTER guard: which models each profile's yml
  // leaf declares. Same source of truth as the on-status `supportedModels`
  // field; exposed as a lookup so the renderer can hydrate before any
  // status event fires (e.g. onboarding + boot race) and can preview other
  // profiles' models in the picker without switching.
  ipcMain.handle('profiles:models', () => {
    const map = {}
    for (const n of listProfiles()) map[n] = modelsFor(n)
    return { activeProfile: currentProfileName, models: map }
  })
  ipcMain.handle('runtime:start', async (_e, { name }) => {
    await startRuntime(name)
    // Persist the user's pick so next boot honors it. Merge into any
    // existing config (onboarding role/approvalMode/createdAt); missing
    // config is fine — write a new one with just `profile`. Best-effort:
    // never let a fs error block the actual runtime start.
    try {
      const existing = P.readShellConfig() || {}
      P.writeShellConfig({ ...existing, profile: name })
    } catch (err) {
      console.debug('[runtime:start] profile persistence failed (non-fatal):', err.message)
    }
    return { ok: true }
  })
  ipcMain.handle('runtime:status', () => ({
    status: supervisor?.status || 'idle',
    profile: currentProfileName,
    model: supervisor ? profile(currentProfileName).model : null,
    // Preflight (2026-07-18): supported-models list rides on every status
    // payload so the renderer's composer dropdown always knows what the
    // active profile can route. See onStatus handler in renderer.js.
    supportedModels: currentProfileName ? modelsFor(currentProfileName) : [],
    serverInfo: supervisor?.serverInfo || null,
    serverCapabilities: supervisor?.serverCapabilities || null,
  }))

  // Session list is server-authoritative. session/list on a v2 server returns
  // { sessions: [{ sessionId, header, live, persisted }, ...] } with title /
  // running / lastEventTime derived on the server. We surface those verbatim.
  ipcMain.handle('sessions:list', async () => {
    // Two silent-empty cases: (a) no supervisor yet (renderer polled before
    // startRuntime returned); (b) supervisor exists but its client isn't
    // ready — startRuntime is still in `daemon.ensureUp()` or `_spawnOnce`.
    // Both are transient boot-race states; the renderer's `onInitialized`
    // handler calls `refreshSessionList()` once the runtime finishes, so we
    // don't need to surface anything here. Emitting `runtime:error` for a
    // 500ms boot race just spams the empty-state chat with a scary line.
    if (!supervisor || !supervisor.client) return []
    try {
      const result = await supervisor.request('session/list', {})
      return (result && result.sessions) || []
    } catch (err) {
      // Server lacking session/list (v1) — fall back to empty. The UI is
      // still functional; sessions get created lazily by session/prompt.
      // Log to main-process stdout so a debugging user can still see it,
      // but don't fire it into the renderer as a user-facing error line.
      console.debug(`session/list unavailable: ${err.message}`)
      return []
    }
  })
  ipcMain.handle('sessions:new', async (_e, _args) => {
    if (!supervisor) throw new Error('runtime not started')
    const sessionId = crypto.randomUUID()
    try {
      // v2: explicit session creation.
      await supervisor.request('session/new', { sessionId })
    } catch (_err) {
      // v1 fallback — session/prompt will lazily create it when the user
      // sends the first turn.
    }
    return { id: sessionId }
  })

  // session/fork: create a child session seeded from `sessionId`, optionally
  // truncated at `boundary` (highest inherited seq — plain number per the
  // protocol group's final SessionForkParams shape on
  // .worktrees/jsonrpc-v2 feat/jsonrpc-set-config). The wire method is
  // still landing — until it does, fall back to session/new + a synthetic
  // subagent.started notification so the sidebar tree UI is drivable
  // end-to-end today. The synthetic path is flagged `mocked: true` so the
  // renderer can badge the button and callers know the child is empty,
  // not seeded.
  ipcMain.handle('sessions:fork', async (_e, { sessionId, boundary }) => {
    if (!supervisor) throw new Error('runtime not started')
    if (!sessionId) throw new Error('sessions:fork needs a sessionId')
    // Accept both a plain number (wire shape) and a legacy `{ seq }` object
    // from any older caller path, normalising down to the number on the way
    // out. Once every caller in this repo passes a number this coercion can
    // go.
    const boundarySeq =
      typeof boundary === 'number'
        ? boundary
        : boundary && typeof boundary.seq === 'number'
          ? boundary.seq
          : undefined
    try {
      const params = { sessionId }
      if (typeof boundarySeq === 'number') params.boundary = boundarySeq
      const result = await supervisor.request('session/fork', params)
      const childSessionId = result && (result.childSessionId || result.id)
      if (!childSessionId) throw new Error('session/fork returned no childSessionId')
      // The daemon will also emit its own subagent.started; we don't
      // synthesize one here.
      return { childSessionId, mocked: false }
    } catch (err) {
      // Two-way branch. A real SessionForkError
      // from the wire (OPEN_TURN, INVALID_BOUNDARY, SESSION_NOT_LIVE,
      // SESSION_NOT_FOUND, SESSION_ALREADY_EXISTS) is not a "runtime
      // doesn't support fork" signal — it means the request landed and the
      // kernel rejected it on deterministic grounds. Falling through to the
      // mock path would drown that signal in a synthetic empty child. Instead
      // resolve with `rejected: true, code, message` so the renderer can
      // render a code-specific system line. The JSON-RPC transport flattens
      // SessionForkError.code down to a bare -32603 with the message
      // preserved, so we classify by parsing that message (see
      // fork-error-classify.js).
      const classified = classifyForkErrorMessage(err && err.message)
      if (classified !== null) {
        return { rejected: true, code: classified, message: err.message }
      }
      // Runtime doesn't know session/fork yet (or the child failed to
      // materialize for reasons we don't recognise) — mock. Mint a fresh id,
      // register it on the daemon so session/list will surface it, and emit
      // a synthetic subagent.started to drive the sidebar tree + inline fork
      // marker via the same channel real forks would use.
      const childSessionId = crypto.randomUUID()
      try { await supervisor.request('session/new', { sessionId: childSessionId }) } catch (_) { /* v1 or busy — proceed anyway */ }
      // The synthetic notification travels the same runtime:notify IPC as
      // real ones, so the renderer's subagent.started branch handles both.
      send('runtime:notify', {
        method: 'subagent.started',
        params: { parentSessionId: sessionId, childSessionId },
      })
      return { childSessionId, mocked: true, reason: err.message }
    }
  })

  // session/resume: attach an agent to a persisted-only session so the shell
  // can continue chatting on the same session id. Falls back to session/new
  // (with the same id) when the runtime lacks persistence — the fallback
  // keeps the sidebar History → click path drivable, at the cost of an empty
  // replay window. `resumed:false` badges the entry as mocked on the way out.
  ipcMain.handle('sessions:resume', async (_e, { sessionId } = {}) => {
    if (!supervisor) throw new Error('runtime not started')
    if (!sessionId) throw new Error('sessions:resume needs a sessionId')
    try {
      await supervisor.request('session/resume', { sessionId })
      return { sessionId, resumed: true }
    } catch (err) {
      try { await supervisor.request('session/new', { sessionId }) } catch (_) { /* accept */ }
      return { sessionId, resumed: false, reason: err.message }
    }
  })

  // shell:openExternal — enforce the http/https whitelist at the IPC edge so
  // no code path can ship a `file:///` or `javascript:` URL to the browser.
  ipcMain.handle('shell:openExternal', async (_e, { url } = {}) => {
    if (typeof url !== 'string' || url === '') throw new Error('shell:openExternal needs a url')
    let scheme = ''
    try { scheme = new URL(url).protocol } catch (_) { throw new Error(`invalid url: ${url}`) }
    if (scheme !== 'http:' && scheme !== 'https:') {
      throw new Error(`refusing to open non-http(s) scheme: ${scheme}`)
    }
    const { shell } = require('electron')
    await shell.openExternal(url)
    return { ok: true }
  })

  ipcMain.handle('session:events', async (_e, { sessionId, seq, before, after }) => {
    if (!supervisor) throw new Error('runtime not started')
    const params = { sessionId }
    if (seq !== undefined && seq !== null) {
      params.seq = seq
      if (before !== undefined) params.before = before
      if (after !== undefined) params.after = after
    }
    return supervisor.request('session/events', params)
  })
  ipcMain.handle('session:prompt', async (_e, { sessionId, text }) => {
    if (!supervisor) throw new Error('runtime not started')
    return supervisor.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })
  })
  ipcMain.handle('session:cancel', async (_e, { sessionId, reason }) => {
    if (!supervisor) throw new Error('runtime not started')
    return supervisor.request('session/cancel', { sessionId, reason: reason || 'user cancelled' })
  })
  // User-triggered compaction. The wire method `session/compact` is not yet
  // in the shipped protocol (see docs/capability-ui-coverage.md §3 —
  // `session/set_config_option` sits in the same repo-side gap); the shell
  // is wired end-to-end so the moment the daemon lands the method, the
  // "Compact now" button starts working with no renderer change. Until then
  // we return `{ supported: false }` on JSON-RPC MethodNotFound (-32601) so
  // the renderer can grey the button + tooltip why. Anything else re-throws
  // so the user sees the real error.
  ipcMain.handle('session:compact', async (_e, { sessionId }) => {
    if (!supervisor) throw new Error('runtime not started')
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('session:compact needs a sessionId')
    try {
      const result = await supervisor.request('session/compact', { sessionId })
      return { supported: true, result: result || {} }
    } catch (err) {
      if (err && err.code === -32601) return { supported: false, reason: 'MethodNotFound' }
      throw err
    }
  })
  // `session/set_config` — retarget an open session's model without
  // reconnecting the daemon. The wire method landed on the integration branch
  // (see packages/ui/jsonrpc protocol §SessionSetConfigParams). We treat
  // MethodNotFound as "server ran an older protocol" and return `{ supported:
  // false }` so the composer greys the model dropdown out; any other error
  // re-throws so the user sees the real failure. `effective` in the result
  // is 'now' or 'next-turn' — the renderer surfaces it as a subtle badge.
  ipcMain.handle('session:setConfig', async (_e, { sessionId, options }) => {
    if (!supervisor) throw new Error('runtime not started')
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('session:setConfig needs a sessionId')
    if (!options || typeof options !== 'object') throw new Error('session:setConfig needs options')
    try {
      const result = await supervisor.request('session/set_config', { sessionId, options })
      return { supported: true, result: result || {} }
    } catch (err) {
      if (err && err.code === -32601) return { supported: false, reason: 'MethodNotFound' }
      throw err
    }
  })
  ipcMain.handle('interrupt:resolve', (_e, { interruptId, result }) => {
    const entry = pendingInterrupts.get(interruptId)
    if (!entry) return { ok: false, reason: 'unknown interruptId' }
    pendingInterrupts.delete(interruptId)
    // result shape must match InterruptResult: {outcome:'accepted', payload}
    // | {outcome:'rejected'} | {outcome:'cancelled'}. Anything else fails
    // closed to cancelled.
    if (!result || !result.outcome) entry.resolve({ outcome: 'cancelled' })
    else entry.resolve(result)
    return { ok: true }
  })
  ipcMain.handle('runtime:shutdown', async () => {
    if (supervisor) await supervisor.stop()
    supervisor = null
    return { ok: true }
  })

  // ---- Plugin management + onboarding IPC ---------------------------------
  //
  // The Plugins tab renders the effective plugin list (base entries folded
  // with the user overlay); toggles + adds mutate ~/.dsh-desktop/user-overlay.
  // cordis.yml and require a runtime restart to take effect. Restart is a
  // separate IPC ("plugins:restart") the renderer calls after batching edits.
  //
  // Onboarding: renderer asks whether ~/.dsh-desktop exists ("onboarding:
  // needsFirstRun"); if not, it renders the two-step overlay and calls
  // "onboarding:apply" with { role, approvalMode } to write the initial
  // overlay + config, then a runtime restart picks it up.

  function activeBasePath() {
    // The base leaf the Plugins tab reads (fs list + validation input) is
    // whatever the active profile boots from — not always daemon-echo.yml.
    // See profiles.js PROFILE_LEAF for the map; leafPathFor throws on an
    // unknown profile so a typo fails loudly instead of silently defaulting.
    // caught the old daemon-echo.yml hardcode leaking
    // through under stdio-deepseek.
    return require('./profiles.js').leafPathFor(currentProfileName)
  }

  ipcMain.handle('plugins:list', () => {
    const base = P.readBaseEntries(activeBasePath())
    const overlay = P.readOverlayFile(P.overlayPath())
    const entries = P.computeEffective(base, overlay.patches)
    return {
      base: activeBasePath(),
      overlayPath: P.overlayPath(),
      overlayExists: overlay.base !== '',
      entries,
      // Surface the current profile's `vibeCapable` so the renderer can gate
      // the "Vibe a plugin" button without redoing the mock-vs-real check.
      vibeCapable: !!profile(currentProfileName).vibeCapable,
      profileName: currentProfileName,
      // A3 effect heuristics — enabled/disabled counts, near-collision id
      // pairs (prefix overlap OR edit distance ≤ 1), and a tool-dilution
      // warning when the enabled count exceeds the advisory threshold. The
      // renderer paints these as a compact info bar above the diagnostics
      // strip; they are informational rather than blocking.
      summary: H.summarize({ entries }),
    }
  })

  // Runtime plugin view — the truth cordis knows, as reported by the running
  // daemon over the internal JSON-RPC `plugins/list` method. Kept as its own
  // IPC (separate from `plugins:list`, which is fs-only) so the tab can paint
  // the configured columns fast and layer the live column in when the daemon
  // is reachable. A daemon that pre-dates the wire method rejects with
  // MethodNotFound (-32601 / -32601-alike); we degrade to `{ supported: false }`
  // so the renderer can keep its fs-parsed row and simply hide the runtime
  // column. Everything is a plugin, but the shell must survive an old runtime.
  ipcMain.handle('plugins:listRuntime', async () => {
    // No supervisor at all — stdio profile that hasn't booted, or the daemon
    // failed to start. This is not the MethodNotFound path (that means the
    // daemon is old); it's "there's nothing to ask". The renderer folds this
    // into the same 'unknown' health status (per B-P0-1 three-state model)
    // but shows a different phrase — see plugins-ui.js
    // renderDiagnosticsStrip. The reason string is part of the wire contract
    // between main and renderer; do not change without updating both.
    if (!supervisor) return { supported: false, reason: 'no-daemon' }
    try {
      const result = await supervisor.request('plugins/list', {})
      // Runtime honoured the request — surface the array unchanged so the
      // renderer keeps its column mapping trivial.
      return {
        supported: true,
        plugins: Array.isArray(result?.plugins) ? result.plugins : [],
      }
    } catch (err) {
      // JsonRpcError with the -32601 method-not-found code, or a wrapped
      // Error whose message contains the same signal — both mean "daemon is
      // pre-plugins/list", not "the request failed". Anything else is a real
      // error we surface to the tab so the user sees the reason.
      const msg = err && err.message ? String(err.message) : String(err)
      if ((err && err.code === -32601) || /method not found|unknown DeepSeek Harness/i.test(msg)) {
        return { supported: false, reason: 'MethodNotFound' }
      }
      // "runtime not started" — supervisor exists but hasn't been started() yet
      // or the transport hasn't produced a client. Same UX as no-daemon.
      if (/runtime not started/i.test(msg)) {
        return { supported: false, reason: 'no-daemon' }
      }
      return { supported: false, reason: msg }
    }
  })

  // Static validation. Same three questions the Plugins
  // tab shows inline: does every entry name resolve to a real package or
  // relative-path file, does every patch id target an entry that exists in
  // the base leaf, and does the effective list look coherent (duplicate
  // ids, near-duplicate ids that suggest a typo, too many enabled entries).
  // Runs on every save + tab refresh; O(entries²) at worst on tiny inputs
  // so it stays cheap.
  //
  // The workspace-package set is scanned lazily and memoized because the
  // dev-clone `packages/` tree walk is the expensive step (~80 dirs). The
  // memo is invalidated only on process restart; a fresh worktree layout
  // is picked up when the shell restarts.
  let workspacePackages = null
  function packagesRoot() {
    const devRoot = path.resolve(
      process.env.DSH_DEV_ROOT ||
        path.resolve(__dirname, '..', '..', '..', 'deepseek-harness-dev'),
    )
    // Prefer the integration worktree (mirrors what profiles.js resolves the
    // daemon bin against); fall back to the dev-clone root's `packages/`.
    const integrationPkgs = path.join(devRoot, '.worktrees', 'integration', 'packages')
    try { require('node:fs').accessSync(integrationPkgs); return integrationPkgs }
    catch (_) { return path.join(devRoot, 'packages') }
  }
  function knownPackages() {
    if (workspacePackages) return workspacePackages
    workspacePackages = V.scanWorkspacePackages(packagesRoot())
    return workspacePackages
  }
  ipcMain.handle('plugins:validate', () => {
    const baseText = require('node:fs').readFileSync(activeBasePath(), 'utf8')
    const baseEntries = P.parseBaseEntries(baseText)
    const overlay = P.readOverlayFile(P.overlayPath())
    return {
      diagnostics: V.validate({
        baseEntries,
        overlay,
        knownPackages: knownPackages(),
        leafDir: path.dirname(activeBasePath()),
      }),
    }
  })

  // Runtime boot probe (A2). Boots an isolated daemon over the current
  // active leaf (overlay if present, else the base leaf directly), waits
  // for ping-or-fail, tears down. Fail-loud stderr is parsed and mapped to
  // plugin rows. Slow — ~1-3s under mock-echo — so the renderer only
  // invokes this on explicit user action, not on every save.
  ipcMain.handle('plugins:probe', async () => {
    const probeMod = require('./plugin-probe.js')
    const overlayExists = require('node:fs').existsSync(P.overlayPath())
    const overlayOrLeafPath = overlayExists ? P.overlayPath() : activeBasePath()
    const { daemonBin, tsxSpecifier, tsxTsconfigPath } = resolveDaemonRunArgs()
    const baseText = require('node:fs').readFileSync(activeBasePath(), 'utf8')
    const baseEntries = P.parseBaseEntries(baseText)
    const overlay = P.readOverlayFile(P.overlayPath())
    return probeMod.probeBoot({
      overlayOrLeafPath,
      daemonBin, tsxSpecifier, tsxTsconfigPath,
      baseEntries,
      overlayPatches: overlay.patches,
    })
  })

  ipcMain.handle('plugins:toggle', (_e, { id, disabled }) => {
    if (typeof id !== 'string') throw new Error('plugins:toggle needs id')
    // If the overlay doesn't exist yet, seed one that includes the base. This
    // matches onboarding's "coding + ask" default so a user who skipped
    // onboarding and then toggled a plugin ends up in a consistent state.
    let overlay = P.readOverlayFile(P.overlayPath())
    if (!overlay.base) {
      overlay = { base: path.relative(path.dirname(P.overlayPath()), activeBasePath()).split(path.sep).join('/'), patches: [] }
    }
    const next = P.togglePatch(overlay, id, !!disabled)
    P.writeOverlayFile(P.overlayPath(), next)
    Growth.appendEvent('plugin.toggle', { id, disabled: !!disabled })
    return { ok: true, overlayPath: P.overlayPath() }
  })

  ipcMain.handle('plugins:add', (_e, { id, name, config }) => {
    if (typeof id !== 'string' || typeof name !== 'string') {
      throw new Error('plugins:add needs id and name')
    }
    let overlay = P.readOverlayFile(P.overlayPath())
    if (!overlay.base) {
      overlay = { base: path.relative(path.dirname(P.overlayPath()), activeBasePath()).split(path.sep).join('/'), patches: [] }
    }
    // Prevent a duplicate against the base leaf; the include plugin would
    // reject the second entry at load with a less helpful message.
    const base = P.readBaseEntries(activeBasePath())
    if (base.find((e) => e.id === id)) {
      throw new Error(`id "${id}" already exists in the base leaf; toggle it instead`)
    }
    const entry = { id, name }
    if (config && typeof config === 'object') entry.config = config
    const next = P.addPatch(overlay, entry)
    P.writeOverlayFile(P.overlayPath(), next)
    Growth.appendEvent('plugin.add', { id, name })
    return { ok: true, overlayPath: P.overlayPath() }
  })

  // Update the `config:` sub-block on an existing patch (or seed a fresh
  // patch when the row is a base entry the user is configuring for the first
  // time — MCP-client is the current motivating case, its serverName is
  // typically only filled in after install). A `null` config clears the
  // block and drops the patch if it carries nothing else.
  ipcMain.handle('plugins:setConfig', (_e, { id, config }) => {
    if (typeof id !== 'string') throw new Error('plugins:setConfig needs id')
    let overlay = P.readOverlayFile(P.overlayPath())
    if (!overlay.base) {
      overlay = { base: path.relative(path.dirname(P.overlayPath()), activeBasePath()).split(path.sep).join('/'), patches: [] }
    }
    const next = P.setPatchConfig(overlay, id, config || null)
    P.writeOverlayFile(P.overlayPath(), next)
    Growth.appendEvent('plugin.setConfig', { id })
    return { ok: true, overlayPath: P.overlayPath() }
  })

  ipcMain.handle('plugins:restart', async () => {
    // Restart the current profile so the daemon rereads the overlay.
    await startRuntime(currentProfileName)
    Growth.appendEvent('overlay.apply', { profile: currentProfileName })
    return { ok: true, profile: currentProfileName }
  })

  ipcMain.handle('onboarding:status', () => {
    const cfg = P.readShellConfig()
    // A-P0-1 (2026-07-16): firstRun is now keyed off an explicit sentinel
    // that only `onboarding:apply` writes. This avoids the earlier bug where
    // any code path that materialized a default config.json (a runtime
    // restart, an overlay apply from Plugins) flipped firstRun back to false
    // before the wizard ever showed. See plugins.js:onboardedSentinelPath.
    //
    // Preflight (2026-07-18) blind-test #10: reviewer reported the wizard
    // "never fired on fresh user-data". Verified: on a truly empty
    // ~/.dsh-desktop, firstRun=true and maybeShow lifts root.hidden. The
    // reviewer's laptop actually had a stale .onboarded from prior
    // dev/QA runs — sticky by design ("已有用户不弹"). Logging both facts
    // here so the next preflight audit can trivially confirm which case
    // the machine is in via DevTools console.
    const sentinel = P.onboardedSentinelPath()
    const firstRun = !P.onboardedSentinelExists()
    console.log(`[onboarding:status] firstRun=${firstRun} sentinel=${sentinel}`)
    return {
      firstRun,
      config: cfg,
      shellHome: P.shellHome(),
    }
  })

  ipcMain.handle('onboarding:apply', async (_e, { role, approvalMode }) => {
    // Materialize the overlay + config.json, then restart the runtime so the
    // overlay is in effect immediately. Errors bubble to the renderer so the
    // onboarding UI can surface them; the shell falls back to the base leaf
    // if the write half fails.
    const { overlay } = P.applyRoleTemplate(role, approvalMode, activeBasePath(), P.overlayPath())
    P.writeOverlayFile(P.overlayPath(), overlay)
    P.writeShellConfig({ role, approvalMode, createdAt: Date.now() })
    // The sentinel is written last so a crash mid-apply leaves firstRun=true
    // and the wizard reruns on next boot.
    P.markOnboarded()
    await startRuntime(currentProfileName).catch(() => { /* renderer will see runtime:error */ })
    Growth.appendEvent('onboarding.complete', { role, approvalMode })
    return { ok: true }
  })

  ipcMain.handle('onboarding:reset', () => {
    // Wipe config.json + overlay.yml so the next start goes through the
    // onboarding flow again. The Settings pane calls this.
    //
    // A-P0-1 (2026-07-16): also clear the .onboarded sentinel so the wizard
    // actually fires next boot; without this, the old code kept the sentinel
    // in place (there wasn't one), and any auto-materialized config
    // suppressed the wizard.
    const fs = require('node:fs')
    try { fs.rmSync(P.configPath(), { force: true }) } catch (_) {}
    try { fs.rmSync(P.overlayPath(), { force: true }) } catch (_) {}
    P.clearOnboarded()
    return { ok: true }
  })

  // Growth log — the append-only jsonl of runtime-shaping events that the
  // Growth page reads. Returns entries + a hint on the installedAt anchor
  // (config.json.createdAt, when onboarding wrote it) so the renderer can
  // ground the "days together" number even before any log entries exist.
  ipcMain.handle('growth:read', () => {
    const entries = Growth.readAll()
    const cfg = P.readShellConfig()
    return {
      entries,
      installedAt: (cfg && Number.isFinite(cfg.createdAt)) ? cfg.createdAt : null,
      logPath: Growth.growthLogPath(),
    }
  })

  // Growth v2. Reads the three-stage fixture + every
  // user-written rubric/error under ~/.dsh/growth/. Writes land through the
  // add* handlers so the renderer only ever reads/writes via wire — no fs
  // access in the renderer.
  ipcMain.handle('growth:v2Read', () => GrowthV2.readAll())
  ipcMain.handle('growth:v2AddRubric', (_e, { compactWindowId, form } = {}) => GrowthV2.addRubric(compactWindowId, form))
  ipcMain.handle('growth:v2AddError', (_e, { compactWindowId, form } = {}) => GrowthV2.addError(compactWindowId, form))

  // ---------------------------------------------------------------------
  // Hub page (#186 + #190).
  //
  // The Hub reads seven kinds of file-backed assets out of `<shellHome>/hub/`
  // and lets the researcher edit, fork, and run them. Plugins are the hero
  // section and are wire-backed via the existing plugins.list surface; the
  // rest are demo-tier file IO. `scripts:run` spawns the interpreter in a
  // per-run temp dir with a narrowed env (see hub-assets.js). Streaming is
  // done through the standard `send()` channel so the renderer can attach
  // via preload.on('hub:scriptEvent', …).
  // ---------------------------------------------------------------------
  const hubRuntimeDir = () => P.shellHome()
  const hubSamplesDir = path.join(__dirname, '..', '..', 'fixtures', 'hub-samples')

  ipcMain.handle('hub:list', () => {
    // On first list, seed the on-disk store with the sample bundle so the
    // Hub isn't empty on a fresh machine. Idempotent.
    try { HubAssets.seedSamples(hubRuntimeDir(), hubSamplesDir) } catch (_) { /* best effort */ }
    return { rows: HubAssets.listAll(hubRuntimeDir()) }
  })

  ipcMain.handle('hub:read', (_e, { kind, name } = {}) => {
    try {
      const body = HubAssets.readAsset(hubRuntimeDir(), kind, name)
      return { ok: true, body }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  })

  ipcMain.handle('hub:write', (_e, { kind, name, body } = {}) => {
    try {
      const res = HubAssets.writeAsset(hubRuntimeDir(), kind, name, body)
      return { ok: true, ...res }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  })

  ipcMain.handle('hub:versions', (_e, { kind, name } = {}) => {
    try {
      const p = path.join(HubAssets.kindDir(hubRuntimeDir(), kind),
        /\.[A-Za-z0-9]{1,6}$/.test(name) ? name : `${name}.${HubAssets.KIND_EXT[kind]}`)
      return { ok: true, versions: HubAssets.listVersions(p) }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  })

  ipcMain.handle('hub:readVersion', (_e, { kind, path: versionPath } = {}) => {
    try {
      const body = HubAssets.readVersion(hubRuntimeDir(), kind, versionPath)
      return { ok: true, body }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  })

  // Streaming script run. We fire `hub:scriptEvent` notifications as the
  // child produces stdout/stderr so the renderer's output panel can update
  // live. The final `exit` event carries the parsed summary + output row
  // count so the caller can render the diff chip.
  ipcMain.handle('hub:scriptRun', (_e, { scriptName, lang, input, runId: caller } = {}) => {
    try {
      if (!HubAssets.isSafeName(scriptName)) throw new Error(`unsafe script name: ${scriptName}`)
      const scriptPath = path.join(HubAssets.kindDir(hubRuntimeDir(), 'script'),
        /\.[A-Za-z0-9]{1,6}$/.test(scriptName) ? scriptName : `${scriptName}.py`)
      const { runId } = HubAssets.runScript(hubRuntimeDir(), {
        scriptPath, lang, input,
        on: (ev) => send('hub:scriptEvent', { runId: caller || runId, ...ev }),
      })
      return { ok: true, runId: caller || runId }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  })

  ipcMain.handle('hub:scriptCancel', (_e, { runId } = {}) => {
    return { ok: HubAssets.cancelRun(runId) }
  })

  // Vibe: spawn a dedicated runtime under a leaf that mounts the self-
  // referential cordis toolset (see config/daemon-vibe.yml + deepseek-vibe.yml)
  // and create a session on it. Keeps the shell in the same profile lane
  // (echo vs deepseek) and preserves the current profile for the "back to
  // chat" button; the mock-echo variant boots but the vibe entry stays gated
  // on `vibeCapable` because mock-echo can't actually compose plugins.
  ipcMain.handle('plugins:vibeStart', async () => {
    const p = profile(currentProfileName)
    if (!p.vibeCapable) {
      throw new Error(
        `current profile "${currentProfileName}" is not vibe-capable; ` +
        `switch to "stdio-vibe-deepseek" first`,
      )
    }
    const sessionId = crypto.randomUUID()
    try { await supervisor.request('session/new', { sessionId }) } catch (_) { /* v1 → lazy create */ }
    Growth.appendEvent('plugin.vibe-authored', { sessionId, profile: currentProfileName })
    return { sessionId }
  })

  // ---- Plugin market (Browse tab) -----------------------------------------
  //
  // The market ships a curated JSON index at config/plugin-index.json (demo
  // stance — a future remote source lives behind the same shape). Browse
  // reads the parsed rows + install status; install writes a user-overlay
  // patch through the same plugins.addPatch path so the Installed tab stays
  // authoritative. Uninstall only touches patches the market itself added
  // (installSource === 'user'); base-shipped entries can be disabled from the
  // Installed tab but not uninstalled from Browse.

  let cachedIndex = null
  function readMarketIndex() {
    if (cachedIndex) return cachedIndex
    const indexPath = path.join(require('./profiles.js').configDir, 'plugin-index.json')
    const text = require('node:fs').readFileSync(indexPath, 'utf8')
    cachedIndex = M.parseIndex(text)
    return cachedIndex
  }

  ipcMain.handle('market:list', () => {
    const index = readMarketIndex()
    const baseEntries = P.readBaseEntries(activeBasePath())
    const overlay = P.readOverlayFile(P.overlayPath())
    const rows = M.computeMarketState(index, baseEntries, overlay.patches)
    return {
      source: index.source,
      updatedAt: index.updatedAt || null,
      skipped: index.skipped || [],
      rows,
    }
  })

  ipcMain.handle('market:install', (_e, { id }) => {
    if (typeof id !== 'string' || !id) throw new Error('market:install needs id')
    const index = readMarketIndex()
    const row = index.entries.find((r) => r.id === id)
    if (!row) throw new Error(`market: unknown index id "${id}"`)
    let overlay = P.readOverlayFile(P.overlayPath())
    if (!overlay.base) {
      overlay = {
        base: path.relative(path.dirname(P.overlayPath()), activeBasePath())
          .split(path.sep).join('/'),
        patches: [],
      }
    }
    // If the target entry already lives in the base leaf, there's nothing to
    // install — the UI should be showing "Installed" already. Return that
    // state so the renderer can just re-render.
    const base = P.readBaseEntries(activeBasePath())
    if (base.find((e) => e.id === row.entry.id)) {
      return { ok: true, alreadyInstalled: true, source: 'base' }
    }
    const clash = overlay.patches.find((p) => p.id === row.entry.id)
    if (clash) {
      // Already patched. If disabled, flip it back on; otherwise no-op.
      if (clash.disabled) {
        const next = P.togglePatch(overlay, row.entry.id, false)
        P.writeOverlayFile(P.overlayPath(), next)
        return { ok: true, reEnabled: true }
      }
      return { ok: true, alreadyInstalled: true, source: 'user' }
    }
    const next = P.addPatch(overlay, { id: row.entry.id, name: row.entry.name })
    P.writeOverlayFile(P.overlayPath(), next)
    return { ok: true, overlayPath: P.overlayPath() }
  })

  ipcMain.handle('market:uninstall', (_e, { id }) => {
    if (typeof id !== 'string' || !id) throw new Error('market:uninstall needs id')
    const index = readMarketIndex()
    const row = index.entries.find((r) => r.id === id)
    if (!row) throw new Error(`market: unknown index id "${id}"`)
    const overlay = P.readOverlayFile(P.overlayPath())
    const base = P.readBaseEntries(activeBasePath())
    if (base.find((e) => e.id === row.entry.id)) {
      // Base-shipped entries can't be uninstalled by the market — the user
      // should use the Installed tab's toggle instead. Fail loud so the UI
      // surfaces a helpful message.
      throw new Error(
        `"${row.title}" ships with the base leaf; uninstall is not supported. ` +
        `Disable it from the Installed tab instead.`,
      )
    }
    const idx = overlay.patches.findIndex((p) => p.id === row.entry.id)
    if (idx < 0) return { ok: true, wasInstalled: false }
    const next = { base: overlay.base, patches: overlay.patches.slice() }
    next.patches.splice(idx, 1)
    P.writeOverlayFile(P.overlayPath(), next)
    return { ok: true, wasInstalled: true }
  })

  // ---- Pull Requests page --------------------------------------------------
  //
  // We shell out to `gh` in the daemon-profile cwd (which points at the
  // deepseek-harness-dev repo — a real gh-recognized checkout) and cache the
  // result for 60s. `refresh` bypasses the cache. When gh is unavailable or
  // unauthenticated, we fall back to a small demo dataset so the tab always
  // has something to show; the renderer paints a "connect gh CLI" banner
  // when it sees `source: 'demo'`.
  //
  // Handlers live here rather than in a submodule because they need to reach
  // into `profile(currentProfileName).daemon.cwd` — the shell-owned data
  // plumbing that main.js already coordinates.

  let prsCache = null // { fetchedAt, payload }
  const PR_CACHE_TTL_MS = 60 * 1000

  function activeRepoDir() {
    // Prefer the current profile's cwd, but only when it is actually a git
    // checkout: the daemon profile deliberately runs from a tmp runtime dir
    // (socket + sessions), and running `gh` there yields "not a git
    // repository" → permanent demo data. Anything non-repo falls through to
    // the dev clone.
    const fallback = path.resolve(__dirname, '..', '..', '..', 'deepseek-harness-dev')
    const p = profile(currentProfileName)
    const candidates = [
      p && p.daemon && p.daemon.cwd,
      p && p.cwd,
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c && fs.existsSync(path.join(c, '.git'))) return c
    }
    return fallback
  }

  async function collectPRs() {
    const cwd = activeRepoDir()
    const detect = await GH.detectGh({})
    if (!detect.available) {
      return {
        source: 'demo',
        error: detect.reason || 'gh CLI unavailable',
        repo: null,
        rows: GH.demoRows(),
        viewer: '',
      }
    }
    try {
      // Repo detection + PR list run in parallel — both are cheap and the
      // renderer wants both before it can render the subtitle.
      const [repo, list] = await Promise.all([
        GH.detectRepo({ cwd }),
        GH.listPRs({ cwd }),
      ])
      let viewer = ''
      try {
        // Through gh-prs.detectViewer so the spawn gets GH_ENV's PATH fix —
        // a bare execFile here ENOENTs under GUI launch (drift D37).
        viewer = await GH.detectViewer()
      } catch (_) { /* viewer stays empty */ }
      return {
        source: 'gh',
        error: null,
        repo,
        rows: list.rows,
        viewer,
      }
    } catch (err) {
      // gh is installed but this cwd is not a repo it can talk to (e.g. the
      // dev clone was moved). Fall back to demo so the page still renders,
      // and surface the reason so the banner can hint at the fix.
      return {
        source: 'demo',
        error: err.message,
        repo: null,
        rows: GH.demoRows(),
        viewer: '',
      }
    }
  }

  ipcMain.handle('prs:list', async () => {
    if (prsCache && Date.now() - prsCache.fetchedAt < PR_CACHE_TTL_MS) {
      return { ...prsCache.payload, cached: true, fetchedAt: prsCache.fetchedAt }
    }
    const payload = await collectPRs()
    prsCache = { fetchedAt: Date.now(), payload }
    return { ...payload, cached: false, fetchedAt: prsCache.fetchedAt }
  })

  ipcMain.handle('prs:refresh', async () => {
    prsCache = null
    const payload = await collectPRs()
    prsCache = { fetchedAt: Date.now(), payload }
    return { ...payload, cached: false, fetchedAt: prsCache.fetchedAt }
  })

  // ---- Playground: isolated scratch runtime for testing overlay edits ------
  //
  // The plugin Playground boots a dedicated dsh-daemon-demo against a scratch
  // copy of the user overlay; the renderer drives it via a distinct IPC
  // surface so notifications from the two runtimes never mingle. Two commit
  // paths: apply (scratch overlay → live overlay + restart main runtime) or
  // discard (kill isolated daemon, drop scratch dir).
  //
  // `resolveDaemonRunArgs` is also used by the boot-probe IPC above (via a
  // forward reference — plugins:probe reads this closure once at call time,
  // not at handler registration).
  const playgroundModule = require('./playground.js')
  let playground = null

  function resolveDaemonRunArgs() {
    const devRoot = process.env.DSH_DEV_ROOT
      ? path.resolve(process.env.DSH_DEV_ROOT)
      : path.resolve(__dirname, '..', '..', '..', 'deepseek-harness-dev')
    const worktreeBin = path.join(devRoot, '.worktrees', 'integration',
      'packages', 'examples', 'daemon-demo', 'src', 'bin.ts')
    const daemonBin = require('node:fs').existsSync(worktreeBin)
      ? worktreeBin
      : path.join(devRoot, 'packages', 'examples', 'daemon-demo', 'src', 'bin.ts')
    let tsxSpecifier
    try {
      tsxSpecifier = require.resolve('tsx', { paths: [path.dirname(daemonBin)] })
    } catch (_) { tsxSpecifier = 'tsx' }
    const tsxTsconfigPath = path.join(
      daemonBin.includes('.worktrees')
        ? path.join(devRoot, '.worktrees', 'integration')
        : devRoot,
      'tsconfig.json',
    )
    return { daemonBin, tsxSpecifier, tsxTsconfigPath }
  }

  ipcMain.handle('playground:start', async () => {
    if (playground) return { ok: true, status: 'already-running' }
    const { daemonBin, tsxSpecifier, tsxTsconfigPath } = resolveDaemonRunArgs()
    try {
      playground = await playgroundModule.startPlayground({
        liveOverlayPath: P.overlayPath(),
        baseLeafPath: activeBasePath(),
        daemonBin, tsxSpecifier, tsxTsconfigPath,
        onNotify: (method, params) => send('playground:notify', { method, params }),
        onStatus: (status) => send('playground:status', { status }),
        onCrash: (info) => send('playground:crash', info),
        onStderr: (chunk) => send('playground:stderr', chunk),
        onInterrupt,
      })
      return { ok: true, status: 'started', scratchDir: playground.scratchDir }
    } catch (err) {
      throw new Error(
        `playground boot failed: ${err.message}` +
        (err.stderrTail ? `\n--- daemon stderr ---\n${err.stderrTail}` : ''),
      )
    }
  })

  ipcMain.handle('playground:newSession', async () => {
    if (!playground) throw new Error('playground not started')
    const sessionId = crypto.randomUUID()
    try { await playground.supervisor.request('session/new', { sessionId }) }
    catch (_) { /* v1 fallback */ }
    playground.sessions.add(sessionId)
    return { id: sessionId }
  })

  ipcMain.handle('playground:prompt', async (_e, { sessionId, text }) => {
    if (!playground) throw new Error('playground not started')
    return playground.supervisor.prompt({
      sessionId, contentBlocks: [{ type: 'text', text }],
    })
  })

  ipcMain.handle('playground:cancel', async (_e, { sessionId, reason }) => {
    if (!playground) throw new Error('playground not started')
    return playground.supervisor.request('session/cancel', {
      sessionId, reason: reason || 'playground user cancelled',
    })
  })

  ipcMain.handle('playground:events', async (_e, { sessionId, seq, before, after }) => {
    if (!playground) throw new Error('playground not started')
    const params = { sessionId }
    if (seq !== undefined && seq !== null) {
      params.seq = seq
      if (before !== undefined) params.before = before
      if (after !== undefined) params.after = after
    }
    return playground.supervisor.request('session/events', params)
  })

  ipcMain.handle('playground:apply', async () => {
    if (!playground) throw new Error('playground not started')
    playgroundModule.applyScratchOverlay(playground, P.overlayPath())
    await playgroundModule.stopPlayground(playground)
    playground = null
    await startRuntime(currentProfileName)
    return { ok: true }
  })

  ipcMain.handle('playground:discard', async () => {
    if (!playground) return { ok: true, wasRunning: false }
    await playgroundModule.stopPlayground(playground)
    playground = null
    return { ok: true, wasRunning: true }
  })

  ipcMain.handle('playground:list', () => {
    if (!playground) throw new Error('playground not started')
    const baseText = require('node:fs').readFileSync(activeBasePath(), 'utf8')
    const baseEntries = P.parseBaseEntries(baseText)
    const overlay = P.readOverlayFile(playground.scratchOverlayPath)
    return {
      base: activeBasePath(),
      scratchOverlayPath: playground.scratchOverlayPath,
      entries: P.computeEffective(baseEntries, overlay.patches),
    }
  })

  // Toggle inside the SCRATCH overlay + reboot the isolated daemon over the
  // same scratch dir. We can't just call startPlayground again (that re-seeds
  // a new scratch); we tear down the supervisor + isolated child and spawn
  // fresh against the mutated file.
  ipcMain.handle('playground:toggle', async (_e, { id, disabled }) => {
    if (!playground) throw new Error('playground not started')
    let overlay = P.readOverlayFile(playground.scratchOverlayPath)
    if (!overlay.base) overlay = { base: activeBasePath(), patches: [] }
    const next = P.togglePatch(overlay, id, !!disabled)
    P.writeOverlayFile(playground.scratchOverlayPath, next)
    const prev = playground
    playground = null
    try { await prev.supervisor.stop() } catch (_) {}
    try { await prev.isolated.dispose() } catch (_) {}
    const { daemonBin, tsxSpecifier, tsxTsconfigPath } = resolveDaemonRunArgs()
    const { spawnIsolatedDaemon } = require('./isolated-daemon.js')
    const isolated = await spawnIsolatedDaemon({
      overlayOrLeafPath: prev.scratchOverlayPath,
      daemonBin, tsxSpecifier, tsxTsconfigPath,
      cwd: prev.scratchDir, purpose: 'playground',
    })
    const supervisor = new RuntimeSupervisor({
      profile: {
        mode: 'daemon',
        daemon: {
          cmd: process.execPath,
          args: ['--import', tsxSpecifier, daemonBin, prev.scratchOverlayPath],
          cwd: prev.scratchDir,
          env: {
            TSX_TSCONFIG_PATH: tsxTsconfigPath,
            DSH_DAEMON_SOCKET_PATH: isolated.socketPath,
            DSH_DAEMON_LOCKFILE_PATH: isolated.lockfilePath,
            DSH_DAEMON_SESSIONS_ROOT: isolated.sessionsRoot,
          },
          socketPath: isolated.socketPath,
        },
        model: 'mock-echo', label: 'playground · isolated daemon',
        protocolVersion: 2, capabilities: { interruptions: true },
        onInterrupt,
      },
    })
    supervisor.on('notify', (m, p) => send('playground:notify', { method: m, params: p }))
    supervisor.on('status', (s) => send('playground:status', { status: s }))
    supervisor.on('crash', (info) => send('playground:crash', info))
    supervisor.on('stderr', (chunk) => send('playground:stderr', chunk))
    await supervisor.start()
    playground = new playgroundModule.PlaygroundSession({
      scratchOverlayPath: prev.scratchOverlayPath,
      scratchDir: prev.scratchDir,
      isolated, supervisor, profile: prev.profile,
      originalBaseRef: prev.originalBaseRef,
    })
    return { ok: true }
  })

  // Auto-start the initial profile. Selection order:
  //   1. shellConfig.profile (a persisted user pick — never overridden)
  //   2. 'stdio-deepseek' (2026-07-18 default: aim at the real model on
  //      first-run so new downloaders see DeepSeek replies, not echoes)
  // If the profile is stdio-deepseek AND the user has no DEEPSEEK_API_KEY,
  // the runtime will still spawn — llm-deepseek throws "an API key is
  // required" mid-init, classifyRuntimeError buckets it as missing-api-key,
  // and the renderer surfaces a guided switch card (offering daemon-echo
  // for a keyless UI walkthrough). We deliberately do NOT auto-switch: the
  // team-lead directive is "no red wall, no stuck starting" but respect the
  // user's ability to try the real model first.
  //
  // Kernel-level failures (dev-clone missing, spawn ENOENT) still fall back
  // to stdio-echo so the shell isn't dead-in-the-water; those surface via
  // classifyRuntimeError's ENOENT bucket, unchanged.
  const persisted = (() => {
    try {
      const cfg = P.readShellConfig()
      const list = listProfiles()
      if (cfg && typeof cfg.profile === 'string' && list.includes(cfg.profile)) {
        return cfg.profile
      }
    } catch (_) { /* corrupt config falls through to default */ }
    return null
  })()
  const bootProfile = persisted || 'stdio-deepseek'
  try {
    await startRuntime(bootProfile)
  } catch (err) {
    send('runtime:error', { message: `${bootProfile} boot failed, falling back to stdio-echo: ${err.message}` })
    try { await startRuntime('stdio-echo') } catch (err2) {
      send('runtime:error', { message: `stdio fallback failed too: ${err2.message}` })
    }
  }
})

app.on('window-all-closed', async () => {
  if (supervisor) await supervisor.stop().catch(() => {})
  await artifactIpc.closeArtifactServer().catch(() => {})
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  try { globalShortcut.unregisterAll() } catch (_) { /* already gone */ }
  if (supervisor) await supervisor.stop().catch(() => {})
  await artifactIpc.closeArtifactServer().catch(() => {})
})
