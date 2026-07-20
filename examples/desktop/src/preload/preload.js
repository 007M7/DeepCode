// Minimal, sealed IPC surface exposed to the renderer. contextIsolation is
// on, so this is the only bridge — nothing else from node/electron leaks.

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const listeners = new Map()
function on(channel, cb) {
  const wrap = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, wrap)
  listeners.set(cb, { channel, wrap })
  return () => {
    ipcRenderer.removeListener(channel, wrap)
    listeners.delete(cb)
  }
}

contextBridge.exposeInMainWorld('dsh', {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  // Preflight (2026-07-18) NO_ADAPTER guard: which models each profile
  // registers, sourced from profiles.js:PROFILE_MODELS (mirrors each yml
  // leaf's `models:` block). Renderer uses this to filter the composer
  // model dropdown so users can't pick `deepseek-v4-flash` under
  // `daemon-echo` and hit `no adapter registered` on every send.
  profilesModels: () => ipcRenderer.invoke('profiles:models'),
  startRuntime: (name) => ipcRenderer.invoke('runtime:start', { name }),
  shutdownRuntime: () => ipcRenderer.invoke('runtime:shutdown'),
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  newSession: () => ipcRenderer.invoke('sessions:new', {}),
  forkSession: ({ sessionId, boundary } = {}) =>
    ipcRenderer.invoke('sessions:fork', { sessionId, boundary }),
  // Resume a persisted-only session: flips it from `live:false` to a live
  // agent so the same session id can accept new turns. Main falls through to
  // session/new when the runtime lacks session/resume — the sidebar History
  // click path stays drivable end-to-end today, at the cost of empty replay.
  resumeSession: (sessionId) => ipcRenderer.invoke('sessions:resume', { sessionId }),
  // Route an external URL through main so shell.openExternal enforces the
  // http/https whitelist (mirrors artifact-ipc's edge). The renderer never
  // hands a URL to the browser directly.
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  sessionEvents: (sessionId, opts = {}) =>
    ipcRenderer.invoke('session:events', { sessionId, ...opts }),
  sendPrompt: (sessionId, text) => ipcRenderer.invoke('session:prompt', { sessionId, text }),
  cancelPrompt: (sessionId, reason) => ipcRenderer.invoke('session:cancel', { sessionId, reason }),
  // User-triggered compaction. The `session/compact` wire method is not yet
  // in the shipped protocol; main.js catches MethodNotFound and returns
  // `{ supported: false }` so the renderer greys the button and shows a
  // tooltip. See src/renderer/context-meter.js for the meter that drives it.
  compactSession: (sessionId) => ipcRenderer.invoke('session:compact', { sessionId }),
  // `session/set_config` — swap the effective model on an open session. Returns
  // `{ supported: false }` on older daemons (MethodNotFound); `{ supported:
  // true, result: { effective: 'now' | 'next-turn' } }` on success. The
  // composer's model dropdown uses this; a `next-turn` result means the change
  // was queued behind an in-flight turn and will promote at the next boundary.
  setSessionConfig: (sessionId, options) =>
    ipcRenderer.invoke('session:setConfig', { sessionId, options }),
  resolveInterrupt: (interruptId, result) =>
    ipcRenderer.invoke('interrupt:resolve', { interruptId, result }),
  onNotify: (cb) => on('runtime:notify', cb),
  onStatus: (cb) => on('runtime:status', cb),
  onCrash: (cb) => on('runtime:crash', cb),
  onStderr: (cb) => on('runtime:stderr', cb),
  onError: (cb) => on('runtime:error', cb),
  onInitialized: (cb) => on('runtime:initialized', cb),
  onInterruptIncoming: (cb) => on('interrupt:incoming', cb),
  onInterruptInvalidate: (cb) => on('interrupt:invalidate', cb),
  // -- artifact preview ------------------------------------------------------
  // The shell hosts a 127.0.0.1 static server that watches an artifact dir
  // (see src/main/artifact-server.js). openArtifact ensures the server is up
  // and then hands the URL to the system browser; getArtifactBase returns the
  // current base URL (or null before first use); listArtifacts returns all
  // known artifacts; mockArtifact drops a sample HTML into the dir so the
  // debug menu can exercise the whole path without a live model. onArtifact
  // fires when the shell detects a new/updated artifact.
  openArtifact: (artifactId) => ipcRenderer.invoke('artifact:open', { artifactId }),
  getArtifactBase: () => ipcRenderer.invoke('artifact:base'),
  listArtifacts: () => ipcRenderer.invoke('artifact:list'),
  mockArtifact: () => ipcRenderer.invoke('artifact:mock'),
  onArtifact: (cb) => on('artifact:event', cb),
  // -- plugin tab / onboarding ----------------------------------------------
  // Reads/writes ~/.dsh-desktop/{user-overlay.cordis.yml, config.json}.
  // Toggles do NOT auto-restart; renderer batches edits + calls
  // plugins.restart() once done. `vibeStart` mints a session on the current
  // vibe-capable profile so the renderer can seed a new chat with the cordis
  // toolset in scope.
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    // Ask the running daemon for its true `ctx.registry` view over the JSON-RPC
    // `plugins/list` method. Returns `{ supported: true, plugins: [{name,state}] }`
    // on a v2+ server that advertises `capabilities.plugins`, or
    // `{ supported: false }` when MethodNotFound / no daemon — the Plugins tab
    // falls back to its fs-parsed row and only marks mismatches when the real
    // signal is available.
    listRuntime: () => ipcRenderer.invoke('plugins:listRuntime'),
    toggle: (id, disabled) => ipcRenderer.invoke('plugins:toggle', { id, disabled }),
    add: (id, name, config) => ipcRenderer.invoke('plugins:add', { id, name, config }),
    // Update the `config:` sub-block on a patch (MCP-server config card, etc.).
    // Pass `null` to clear the config; renderer batches edits + Apply-restart
    // like every other overlay mutation. See src/renderer/plugins-mcp-card.js.
    setConfig: (id, config) => ipcRenderer.invoke('plugins:setConfig', { id, config }),
    restart: () => ipcRenderer.invoke('plugins:restart'),
    vibeStart: () => ipcRenderer.invoke('plugins:vibeStart'),
    // Static overlay validation (A1): runs on every save + tab refresh,
    // returns `{diagnostics: [{severity, scope, id, line, message}, …]}`.
    validate: () => ipcRenderer.invoke('plugins:validate'),
    // Runtime probe (A2): boots an isolated daemon over the current overlay
    // and returns any fail-loud diagnostics anchored to plugin rows.
    probe: () => ipcRenderer.invoke('plugins:probe'),
  },
  // Plugin marketplace (Browse tab): curated demo index at
  // config/plugin-index.json → parseIndex → per-row install status. Install
  // writes a user-overlay patch; uninstall drops the patch. Restart is
  // still explicit via plugins.restart() so the user can batch multiple
  // installs before the daemon respawns.
  market: {
    list: () => ipcRenderer.invoke('market:list'),
    install: (id) => ipcRenderer.invoke('market:install', { id }),
    uninstall: (id) => ipcRenderer.invoke('market:uninstall', { id }),
  },
  // Playground (B1-3): isolated scratch runtime driven from the Plugins tab.
  // Same shape as the main session IPC but keyed on a separate daemon so
  // notifications from the two runtimes never mingle.
  playground: {
    start: () => ipcRenderer.invoke('playground:start'),
    discard: () => ipcRenderer.invoke('playground:discard'),
    apply: () => ipcRenderer.invoke('playground:apply'),
    newSession: () => ipcRenderer.invoke('playground:newSession'),
    prompt: (sessionId, text) => ipcRenderer.invoke('playground:prompt', { sessionId, text }),
    events: (sessionId, opts = {}) => ipcRenderer.invoke('playground:events', { sessionId, ...opts }),
    cancel: (sessionId, reason) => ipcRenderer.invoke('playground:cancel', { sessionId, reason }),
    list: () => ipcRenderer.invoke('playground:list'),
    toggle: (id, disabled) => ipcRenderer.invoke('playground:toggle', { id, disabled }),
    onNotify: (cb) => on('playground:notify', cb),
    onStatus: (cb) => on('playground:status', cb),
    onCrash: (cb) => on('playground:crash', cb),
    onStderr: (cb) => on('playground:stderr', cb),
  },
  onboarding: {
    status: () => ipcRenderer.invoke('onboarding:status'),
    apply: (role, approvalMode) => ipcRenderer.invoke('onboarding:apply', { role, approvalMode }),
    reset: () => ipcRenderer.invoke('onboarding:reset'),
  },
  // -- left-nav hidden-pages config (lane-nav-optional) ---------------------
  // Read + write the `hiddenPages` array in ~/.dsh-desktop/config.json.
  // Returned value follows the same three-state semantic the renderer
  // filter honors: `undefined` = default (playground+mission hidden),
  // `[]` = show everything, non-empty array = honored as-is.
  nav: {
    getHiddenPages: () => ipcRenderer.invoke('nav:getHiddenPages'),
    setHiddenPages: (hiddenPages) => ipcRenderer.invoke('nav:setHiddenPages', { hiddenPages }),
  },
  // -- growth log (self-evolution audit trail) -------------------------------
  // The main process appends jsonl entries at ~/.dsh-desktop/growth-log.jsonl
  // on runtime-shaping events (plugin add/toggle, overlay apply, vibe
  // sessions, onboarding). growth-v2.js reads them + the current session
  // list to render the compact-window evolution log.
  growth: {
    read: () => ipcRenderer.invoke('growth:read'),
    // Growth v2: compact-window history with rubric/error
    // write-back. Both add* handlers return { ok, entry } | { ok:false, reason }.
    v2Read: () => ipcRenderer.invoke('growth:v2Read'),
    v2AddRubric: (compactWindowId, form) => ipcRenderer.invoke('growth:v2AddRubric', { compactWindowId, form }),
    v2AddError: (compactWindowId, form) => ipcRenderer.invoke('growth:v2AddError', { compactWindowId, form }),
  },
  // -- feedback annotations (inspector Feedback tab / RL seed) ----------------
  // Per-event annotation store at ~/.dsh-desktop/feedback-annotations.json.
  // list() returns { ok, entries:[{sessionId,seq,verdict,note,rubricDim?,at}] };
  // upsert(form)/remove(form) key on (sessionId, seq) and return { ok, ... }.
  feedback: {
    list: () => ipcRenderer.invoke('feedback:list'),
    upsert: (form) => ipcRenderer.invoke('feedback:upsert', { form }),
    remove: (form) => ipcRenderer.invoke('feedback:remove', { form }),
  },
  // -- pull requests page ----------------------------------------------------
  // `list` returns the 60s-cached payload; `refresh` bypasses the cache.
  // Both go through the same normalized shape: { rows, repo, source, viewer,
  // error, fetchedAt } — the renderer never has to branch on `source`
  // except to show the "connect gh CLI" banner when it's 'demo'.
  prs: {
    list: () => ipcRenderer.invoke('prs:list'),
    refresh: () => ipcRenderer.invoke('prs:refresh'),
  },
  // -- hub page (#186 + #190) ------------------------------------------------
  // Seven-kind asset catalog + local script runner. Every hub.* method returns
  // a `{ok, ...}` shape; the renderer never has to catch on the happy path.
  // `hub.script.run` is fire-and-forget — the returned runId is what shows
  // up on subsequent `onScriptEvent` messages so multiple concurrent runs
  // can be demuxed. The renderer generates the runId so it can correlate
  // its own UI state with the stream before the round-trip completes.
  hub: {
    list: () => ipcRenderer.invoke('hub:list'),
    read: (kind, name) => ipcRenderer.invoke('hub:read', { kind, name }),
    write: (kind, name, body) => ipcRenderer.invoke('hub:write', { kind, name, body }),
    versions: (kind, name) => ipcRenderer.invoke('hub:versions', { kind, name }),
    readVersion: (kind, versionPath) => ipcRenderer.invoke('hub:readVersion', { kind, path: versionPath }),
    script: {
      run: (opts) => ipcRenderer.invoke('hub:scriptRun', opts),
      cancel: (runId) => ipcRenderer.invoke('hub:scriptCancel', { runId }),
    },
    onScriptEvent: (cb) => on('hub:scriptEvent', cb),
  },
  // -- quick chat overlay ----------------------------------------------------
  // The global shortcut ⌘⇧Space (registered in main via globalShortcut) fires
  // this event; the renderer's quick-chat module toggles its overlay. If the
  // OS refused the shortcut, the header button still works.
  onQuickChatToggle: (cb) => on('quickchat:toggle', cb),
})

// QA-only surface. Exposed on a separate `dshQa` bridge so nothing in the
// product renderer can touch it; the CDP walkthrough driver evaluates
// `window.dshQa.revealWindow()` before Page.captureScreenshot to give the
// hidden window a compositor surface without stealing focus from the user.
// The main-side IPC handler is registered only when DSH_QA=1, so calling
// this without the env flag would reject with "No handler registered".
if (process.env.DSH_QA === '1') {
  contextBridge.exposeInMainWorld('dshQa', {
    revealWindow: () => ipcRenderer.invoke('window:reveal'),
  })
}

// Dev-debug gate. Renderer noise like per-stderr-chunk logging is off by
// default (would flood devtools during a real session). Set DSH_DEBUG=1
// (same shape as DSH_QA / DSH_MAXIMIZE) to opt in.
contextBridge.exposeInMainWorld('dshDebug', {
  enabled: process.env.DSH_DEBUG === '1',
})
