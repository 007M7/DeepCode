// Artifact IPC surface. Self-registers on require:
//
//   artifact:open(artifactId) → { url }    ensure server is up, open external
//   artifact:list()           → [Entry]    known artifacts
//   artifact:mock()           → { … }      write a sample HTML into the dir
//   artifact:base()           → { url }    server base url (or null)
//
// Broadcasts to every renderer via `artifact:event`:
//   { kind: 'seen', artifactId, path, kind, version, url, reason }
//
// The artifact dir defaults to `<userData>/.artifacts` so a fresh Electron
// launch has a stable workspace-adjacent location for outputs; the demo
// picks that dir up automatically. The RFC specifies the runtime seam owns
// the dir; until that lands, the shell picks it.

'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { app, ipcMain, shell, BrowserWindow } = require('electron')
const { ArtifactServer, isArtifactPath, pathToArtifactId } = require('./artifact-server.js')

// Prefer an override so tests / advanced users can point the shell at a
// working directory (e.g., a DSH session cwd) once we wire per-session dirs.
function defaultArtifactDir() {
  if (process.env.DSH_ARTIFACT_DIR) return path.resolve(process.env.DSH_ARTIFACT_DIR)
  // `app.getPath('userData')` is available after ready; before that we fall
  // back to the CWD-relative `.artifacts` (only the tests hit this path).
  try { return path.join(app.getPath('userData'), '.artifacts') }
  catch { return path.resolve(process.cwd(), '.artifacts') }
}

let server = null
let currentDir = null

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

async function ensureServer() {
  if (server) return server
  const dir = currentDir || defaultArtifactDir()
  currentDir = dir
  server = new ArtifactServer({ artifactDir: dir })
  server.on('artifact', (entry) => {
    broadcast('artifact:event', { kind: 'seen', ...entry })
  })
  await server.ensureStarted()
  return server
}

// Called by main.js when a `tool/result` might carry a workspace file write.
// The path check is a pure function so the renderer can pre-filter too; here
// we notify the server which will pick up the file via its fs.watch anyway,
// but calling in explicitly makes the demo deterministic (fs.watch on a fresh
// file can miss the initial create event on some filesystems).
async function noticeArtifactPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null
  const s = await ensureServer()
  const rel = pathToArtifactId(absPath, s.artifactDir)
  if (!rel) return null   // outside artifact dir
  if (!isArtifactPath(absPath)) return null
  // Poke: if fs.watch already fired we'll be duplicating a note, but the
  // debounce inside ArtifactServer collapses back-to-back notes on the same
  // path. Version numbers are monotonic per path.
  s._noteArtifact(absPath, 'wire')
  return { artifactId: rel, url: s.urlFor(rel) }
}

// Debug menu payload: writes a self-contained sample HTML into the artifact
// dir. Version increments each mock click so a repeat click drives the
// live-reload path (SSE broadcast to any open tab).
async function mockArtifact() {
  const s = await ensureServer()
  const dir = s.artifactDir
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
  const filename = 'mock-artifact.html'
  const abs = path.join(dir, filename)
  const stamp = new Date().toISOString()
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH mock artifact</title>
<style>
:root { color-scheme: light dark; --fg: #111; --bg: #fff; --accent: #4a6cf7; --muted: #666; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e8ef; --bg: #0f1116; --muted: #7c8296; } }
body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
       color: var(--fg); background: var(--bg); margin: 0; padding: 40px; max-width: 780px; margin-inline: auto; }
h1 { font-size: 24px; margin: 0 0 8px; letter-spacing: -0.01em; }
p.lede { color: var(--muted); margin: 0 0 24px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; margin: 20px 0; }
.tile { border: 1px solid color-mix(in oklab, currentColor 15%, transparent);
        border-radius: 10px; padding: 14px 16px; }
.tile .k { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; }
.tile .v { font-size: 22px; font-weight: 600; margin-top: 4px; }
.footer { color: var(--muted); font-size: 12px; margin-top: 32px; padding-top: 16px;
          border-top: 1px dashed color-mix(in oklab, currentColor 20%, transparent); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px;
         background: color-mix(in oklab, var(--accent) 15%, transparent);
         color: var(--accent); font-size: 11.5px; font-weight: 500; }
</style></head><body>
<h1>Mock artifact <span class="badge">demo</span></h1>
<p class="lede">A hand-written HTML page dropped into <code>.artifacts/</code> by the shell's debug menu. Every click bumps the version and pushes a live-reload event over SSE.</p>
<div class="grid">
  <div class="tile"><div class="k">Generated</div><div class="v">${stamp}</div></div>
  <div class="tile"><div class="k">Kind</div><div class="v">HTML</div></div>
  <div class="tile"><div class="k">Route</div><div class="v" style="font-size:14px"><code>/a/${encodeURIComponent(filename)}/</code></div></div>
  <div class="tile"><div class="k">Server</div><div class="v" style="font-size:14px"><code>127.0.0.1</code></div></div>
</div>
<div class="footer">Save this file to trigger a live reload. Follows the artifact preview RFC (2026-07-13).</div>
</body></html>`
  await fs.promises.writeFile(abs, html, 'utf8')
  // Nudge the server so it doesn't need to wait for fs.watch.
  return noticeArtifactPath(abs)
}

// Track paths a still-open bash tool/call is targeting. Bash routinely
// writes files but the tool/result only carries stdout ("(no output)" for a
// heredoc redirect), so we mine paths from the tool/call args when the shell
// command looks like a write (`cat > path`, `tee path`, `> path`, etc.) and
// re-check them when the matching tool/result arrives.
const pendingBashPaths = new Map()  // callId -> [absPath, absPath, ...]

// Introspect a raw session event and, if it looks like a tool/result writing
// a file with an artifact-eligible extension anywhere on disk, mirror it into
// the artifact dir so the preview server picks it up. Called from main.js's
// runtime:notify pipeline. Non-strict: unknown shapes → no-op.
//
// Why we mirror instead of requiring the model to write inside the artifact
// dir: real profiles (stdio-deepseek) run the daemon in the dev-clone cwd
// with bash-local, and the model routinely writes `foo.svg` under whichever
// working dir it picked. Insisting on `.artifacts/` pushes the burden onto
// the prompt / persona; broadening detection here matches the way the RFC
// eventually wants the runtime seam to work — file appears on disk → preview
// available — without needing a system-prompt handshake.
async function inspectSessionEvent(event) {
  if (!event || (event.type !== 'tool/result' && event.type !== 'tool/call')) return
  const data = event.data || event
  // On tool/call for bash, remember any artifact-eligible target paths in the
  // command so we can check them when the matching result arrives.
  if (event.type === 'tool/call') {
    if (data.name === 'bash' && data.callId) {
      const cmd = extractBashCommand(data)
      if (cmd) {
        const paths = extractBashTargetPaths(cmd)
        if (paths.length) pendingBashPaths.set(data.callId, paths)
      }
    }
    return
  }
  if (data.isError) {
    // Failed writes: drop the pending record so it doesn't leak.
    if (data.callId) pendingBashPaths.delete(data.callId)
    return
  }
  await ensureServer()  // guarantees currentDir + server both settle
  const artifactDir = server.artifactDir
  const candidates = extractPathCandidates(data)
  // Splice in any bash-side targets we recorded on the matching tool/call.
  if (data.callId && pendingBashPaths.has(data.callId)) {
    for (const p of pendingBashPaths.get(data.callId)) candidates.push(p)
    pendingBashPaths.delete(data.callId)
  }
  for (const p of candidates) {
    if (!isArtifactPath(p)) continue
    // Absolute path (bash tool result carries these): trust it and either
    // notice-in-place (already inside dir) or mirror in.
    let abs = null
    if (path.isAbsolute(p)) {
      abs = p
    } else {
      // Relative path — the model's cwd is opaque to us. Try a few well-known
      // roots: the daemon cwd (via env), the artifact dir itself, and
      // process.cwd(). First one that exists wins.
      for (const root of candidateRoots()) {
        const trial = path.resolve(root, p)
        try {
          fs.accessSync(trial)
          abs = trial
          break
        } catch (_) { /* keep trying */ }
      }
    }
    if (!abs) continue
    try { fs.accessSync(abs) } catch (_) { continue }  // file doesn't exist
    const rel = path.relative(artifactDir, abs)
    const insideArtifactDir = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    if (insideArtifactDir) {
      await noticeArtifactPath(abs).catch(() => {})
    } else {
      // Copy in so the preview server can serve it. Basename-only id keeps
      // URLs short; a same-name collision bumps the version via fs.watch.
      const mirrored = await mirrorIntoArtifactDir(abs).catch(() => null)
      if (mirrored) await noticeArtifactPath(mirrored).catch(() => {})
    }
  }
}

// Roots we'll try when a tool/result carries a relative path. The daemon's
// cwd is captured at spawn time in profiles.js (~/harness/deepseek-harness-dev
// for stdio-* profiles); we can't peek at it from here, so we probe candidates.
function candidateRoots() {
  const roots = []
  if (server && server.artifactDir) roots.push(server.artifactDir)
  // dev clone (most common — stdio-deepseek runs there)
  const devClone = path.resolve(__dirname, '..', '..', '..', 'deepseek-harness-dev')
  roots.push(devClone)
  // shell workspace root
  roots.push(path.resolve(__dirname, '..', '..'))
  // Electron process cwd
  roots.push(process.cwd())
  // home
  roots.push(require('node:os').homedir())
  return roots
}

// Copy a file into the artifact dir under its basename. Returns the new abs
// path on success. Overwrite is intentional — the model updating "foo.svg"
// twice in one turn should trigger a version bump on the same artifactId.
async function mirrorIntoArtifactDir(sourceAbs) {
  const s = await ensureServer()
  const target = path.join(s.artifactDir, path.basename(sourceAbs))
  await fs.promises.mkdir(s.artifactDir, { recursive: true }).catch(() => {})
  await fs.promises.copyFile(sourceAbs, target)
  return target
}

// Pull the shell command string out of a bash tool/call. The wire ships
// `arguments` either as a JSON string (jsonrpc-demo profile) or a decoded
// object (some daemon paths). Both shapes carry `.command`.
function extractBashCommand(data) {
  let args = data && data.arguments
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return null } }
  if (!args || typeof args !== 'object') return null
  return typeof args.command === 'string' ? args.command : null
}

// From a bash command string, pluck any artifact-eligible target paths the
// command is writing to. Recognises the four common write shapes:
//   cat <<EOF > /path/foo.svg
//   echo … > /path/foo.html
//   printf … > /path/foo.md   (redirection form)
//   tee /path/foo.svg <<EOF
// We deliberately stay narrow: only extension-matching paths, only after a
// write operator. Wildcards and pipelines aren't targeted — those write
// through fs primitives we can't statically pull from a shell string.
function extractBashTargetPaths(cmd) {
  const paths = []
  // Redirection targets: `> /path/foo.svg` or `>> /path/foo.html`
  for (const m of cmd.matchAll(/>{1,2}\s*['"]?([^\s'";|&<>]+\.(?:html|svg|md))['"]?/gi)) {
    paths.push(m[1])
  }
  // tee target
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?['"]?([^\s'";|&<>]+\.(?:html|svg|md))['"]?/gi)) {
    paths.push(m[1])
  }
  return paths
}

// Best-effort path extraction from a tool/result payload. Tool results carry
// heterogeneous shapes across the codebase; we look at a small set of
// well-known fields plus any text block that contains an artifact-like path.
function extractPathCandidates(data) {
  const out = []
  const push = (v) => { if (typeof v === 'string' && v.length > 0) out.push(v) }
  push(data && data.filePath)
  push(data && data.path)
  push(data && data.file)
  push(data && data.meta && data.meta.filePath)
  push(data && data.meta && data.meta.path)
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        // Match anything that looks like a workspace file path ending in an
        // artifact-eligible extension. Kept intentionally narrow so noisy
        // tool output doesn't false-positive.
        const m = block.text.match(/[\w./\\-]+\.(?:html|svg|md)\b/g)
        if (m) for (const p of m) push(p)
      }
    }
  }
  return out
}

// Public: point the server at a different dir before it starts. Called from
// main.js at startup if we want a session-scoped dir; otherwise the default
// is used. Idempotent as long as the server hasn't started.
function setArtifactDir(dir) {
  if (server) throw new Error('artifact server already started; cannot re-target')
  currentDir = dir
}

// Register all the IPC handlers. Safe to call before app.whenReady().
function registerArtifactIpc() {
  ipcMain.handle('artifact:base', async () => {
    if (!server) return { url: null, dir: currentDir || defaultArtifactDir() }
    return { url: server.baseUrl(), dir: server.artifactDir }
  })
  ipcMain.handle('artifact:list', async () => {
    if (!server) return []
    return Array.from(server.knownArtifacts.values()).map((e) => ({
      artifactId: e.artifactId,
      path: e.path,
      kind: e.kind,
      version: e.version,
      seenAt: e.seenAt,
      url: server.urlFor(e.artifactId),
    }))
  })
  ipcMain.handle('artifact:open', async (_e, { artifactId } = {}) => {
    const s = await ensureServer()
    let id = artifactId
    if (!id) {
      // No id ⇒ open the most recent artifact; useful for the "open latest"
      // button in the header.
      const latest = Array.from(s.knownArtifacts.values()).sort((a, b) => b.seenAt - a.seenAt)[0]
      if (!latest) return { ok: false, reason: 'no artifacts yet' }
      id = latest.artifactId
    }
    const url = s.urlFor(id)
    await shell.openExternal(url)
    return { ok: true, url }
  })
  ipcMain.handle('artifact:mock', async () => {
    const r = await mockArtifact()
    return { ok: true, ...r }
  })
}

async function closeArtifactServer() {
  if (server) { await server.close(); server = null }
}

module.exports = {
  registerArtifactIpc,
  ensureServer,
  noticeArtifactPath,
  inspectSessionEvent,
  setArtifactDir,
  closeArtifactServer,
  defaultArtifactDir,
  _internal: { extractPathCandidates },
}
