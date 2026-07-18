// Artifact preview backend for the desktop demo. Watches a workspace-relative
// directory (default `.artifacts/`) for `*.html` / `*.svg` / `*.md` files and
// serves them on 127.0.0.1 with an SSE live-reload channel; the shell opens a
// tab in the system browser (per RFC 2026-07-13, "no embedded webview" for the
// demo — the shell only shows the card entry point).
//
// This is the shell-side moral equivalent of the RFC's `artifact-preview-local`
// package (which will live in the runtime once the seam lands). Until it does,
// the shell watches the filesystem itself so the whole flow — model writes
// file → shell notices → card appears → browser opens → live-reload — can be
// demoed today from either a real `tool/result` event that lands under the
// artifact dir, or the debug menu's `mock: artifact` button.
//
// Design copied straight from `~/harness/artifact-preview-demo/serve.mjs`:
// Node built-ins only, no dependencies, ~one-server-per-runtime shape. Where
// the prototype served a single file, we serve a whole directory keyed by
// artifact id (the file path relative to the artifact dir, url-encoded).

'use strict'

const { createServer } = require('node:http')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.md':   'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
}
const ARTIFACT_EXTS = new Set(['.html', '.svg', '.md'])

const SSE_SNIPPET =
  `<script>new EventSource('/events').addEventListener('reload',()=>location.reload())</script>`

const WRAP_HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;padding:24px;max-width:900px}img{max-width:100%}</style></head><body>`
const WRAP_TAIL = `</body></html>`

// Is `p` an artifact-eligible file path (by extension only)?
function isArtifactPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  return ARTIFACT_EXTS.has(path.extname(p).toLowerCase())
}

// Compute the artifactId (a stable, filesystem-safe token) for a file inside
// the artifact dir. `filePath` and `artifactDir` are both absolute paths.
// Returns null if the file is not inside artifactDir. The id uses forward
// slashes so subdirectory artifacts work on both OSes; it does NOT include the
// extension so a same-basename re-declare across `.md` → `.html` is treated as
// a new artifact (the RFC's "same path ⇒ same id" rule keys off the full
// relative path including extension).
function pathToArtifactId(filePath, artifactDir) {
  const absFile = path.resolve(filePath)
  const absDir  = path.resolve(artifactDir)
  const rel = path.relative(absDir, absFile)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  // Forward slashes for a URL-safe id; the URL path will URI-encode segments.
  return rel.split(path.sep).join('/')
}

// The inverse: given an artifactId and dir, return the absolute file path.
// Rejects ids that would escape the artifact dir (defence-in-depth vs
// `../../../etc/passwd` style requests).
function artifactIdToPath(artifactId, artifactDir) {
  if (typeof artifactId !== 'string') return null
  // Reject empty, absolute, or backslash-containing ids.
  if (artifactId === '' || artifactId.startsWith('/')) return null
  const decoded = decodeURIComponent(artifactId)
  const absDir  = path.resolve(artifactDir)
  const abs = path.resolve(absDir, decoded)
  const rel = path.relative(absDir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

// Pull an artifactId out of a URL of the shape `/a/<id...>` (with the rest
// of the path forming the id, so nested dirs work). Trailing slash allowed.
function parseArtifactUrl(url) {
  if (!url) return null
  // Strip query string.
  const q = url.indexOf('?')
  const clean = q >= 0 ? url.slice(0, q) : url
  const m = /^\/a\/(.+?)\/?$/.exec(clean)
  if (!m) return null
  return m[1]
}

// Injects the SSE snippet into an HTML document. `.md` inputs get wrapped in
// a minimal skeleton; already-full documents get the snippet slotted before
// `</body>`; anything without a `</body>` tag gets it appended.
function preparePage(src, ext) {
  if (ext === '.md') {
    // Trivial md pass-through — no real renderer for the demo; the RFC calls
    // for a proper one at the seam layer. For now we drop the raw source in
    // a <pre> so at least it is readable.
    return `${WRAP_HEAD}<pre style="white-space:pre-wrap">${
      String(src).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
    }</pre>${SSE_SNIPPET}${WRAP_TAIL}`
  }
  if (ext === '.svg') return src  // served as its own document, no wrapping
  const hasHtml = /<html[\s>]/i.test(src)
  let page = hasHtml ? src : (WRAP_HEAD + src + WRAP_TAIL)
  if (/<\/body>/i.test(page)) {
    page = page.replace(/<\/body>/i, `${SSE_SNIPPET}</body>`)
  } else {
    page += SSE_SNIPPET
  }
  return page
}

// ArtifactServer: one instance per shell. Not started until first artifact
// appears; disposed with the app.
class ArtifactServer extends EventEmitter {
  constructor({ artifactDir, port = 0, host = '127.0.0.1' } = {}) {
    super()
    if (!artifactDir) throw new Error('artifactDir required')
    this.artifactDir = path.resolve(artifactDir)
    this.port = port
    this.host = host
    this.server = null
    this.watcher = null
    this.clients = new Set()   // Set<http.ServerResponse>
    this.versions = new Map()  // artifactId -> integer version counter
    this.knownArtifacts = new Map() // artifactId -> { path, kind, version, seenAt }
    this._started = false
    this._starting = null
  }

  // Idempotent: multiple callers can await ensureStarted; the first wins.
  async ensureStarted() {
    if (this._started) return { url: this.baseUrl() }
    if (this._starting) return this._starting
    this._starting = this._start()
    try { return await this._starting } finally { this._starting = null }
  }

  async _start() {
    await fs.promises.mkdir(this.artifactDir, { recursive: true }).catch(() => {})
    this.server = createServer((req, res) => this._handle(req, res))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject)
        const addr = this.server.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        resolve()
      })
    })
    // Start filesystem watcher; { recursive: true } is macOS + Windows only,
    // Linux needs the fallback (see notes below).
    this._startWatcher()
    // Seed knownArtifacts from an initial scan so a mid-session shell start
    // still surfaces existing files.
    for (const entry of await this._scan()) this._noteArtifact(entry.absPath, 'initial')
    this._started = true
    this.emit('listening', { url: this.baseUrl(), port: this.port })
    return { url: this.baseUrl() }
  }

  baseUrl() { return `http://${this.host}:${this.port}` }

  urlFor(artifactId) {
    // The trailing slash lets the SSE snippet's location.reload() keep the
    // same URL after reload (some browsers rewrite bare-file requests).
    return `${this.baseUrl()}/a/${encodeURIComponent(artifactId).replace(/%2F/gi, '/')}/`
  }

  async _scan() {
    const out = []
    async function walk(dir) {
      let entries
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
      catch { return }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) await walk(abs)
        else if (e.isFile() && isArtifactPath(e.name)) out.push({ absPath: abs })
      }
    }
    await walk(this.artifactDir)
    return out
  }

  _startWatcher() {
    // Try recursive first (macOS/Windows). If it throws on Linux, fall back to
    // a shallow watch on the root — good enough for the demo (nested artifacts
    // still work via the initial scan + manual re-declare).
    try {
      this.watcher = fs.watch(this.artifactDir, { recursive: true }, (_type, filename) => {
        if (!filename) return
        const abs = path.join(this.artifactDir, filename)
        // Debounce fs events: filesystems often fire multiple events per save.
        this._debouncedNote(abs)
      })
    } catch (_recursiveFailed) {
      this.watcher = fs.watch(this.artifactDir, (_type, filename) => {
        if (!filename) return
        const abs = path.join(this.artifactDir, filename)
        this._debouncedNote(abs)
      })
    }
  }

  _debouncedNote(absPath) {
    // 60ms coalesces the typical fs-double-fire on save without adding
    // perceptible latency to the reload broadcast.
    this._debouncePending = this._debouncePending || new Map()
    const prev = this._debouncePending.get(absPath)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this._debouncePending.delete(absPath)
      this._noteArtifact(absPath, 'watch')
    }, 60)
    this._debouncePending.set(absPath, t)
  }

  _noteArtifact(absPath, reason) {
    if (!isArtifactPath(absPath)) return
    // Make sure the file still exists (an fs event might be a delete).
    if (!fs.existsSync(absPath)) return
    const id = pathToArtifactId(absPath, this.artifactDir)
    if (!id) return
    const version = (this.versions.get(id) || 0) + 1
    this.versions.set(id, version)
    const kind = path.extname(absPath).toLowerCase().slice(1)
    const entry = { artifactId: id, path: absPath, kind, version, seenAt: Date.now() }
    this.knownArtifacts.set(id, entry)
    this._broadcastReload(id, version)
    this.emit('artifact', { ...entry, reason, url: this.urlFor(id) })
  }

  _broadcastReload(artifactId, version) {
    const payload = `event: reload\ndata: ${JSON.stringify({ artifactId, version })}\n\n`
    for (const res of this.clients) {
      try { res.write(payload) } catch { /* dead conn — will be culled on close */ }
    }
  }

  _handle(req, res) {
    if (req.url === '/events') return this._handleSse(req, res)
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, artifacts: this.knownArtifacts.size }))
    }
    const artifactId = parseArtifactUrl(req.url)
    if (!artifactId) { res.writeHead(404).end('not found'); return }
    const abs = artifactIdToPath(artifactId, this.artifactDir)
    if (!abs) { res.writeHead(400).end('bad artifact id'); return }
    fs.readFile(abs, (err, buf) => {
      if (err) { res.writeHead(404).end('artifact missing'); return }
      const ext = path.extname(abs).toLowerCase()
      const mime = MIME[ext] || 'application/octet-stream'
      if (ARTIFACT_EXTS.has(ext)) {
        const page = preparePage(buf.toString('utf8'), ext)
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' })
        res.end(page)
      } else {
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' })
        res.end(buf)
      }
    })
  }

  _handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    })
    res.write('retry: 300\n\n')
    this.clients.add(res)
    req.on('close', () => this.clients.delete(res))
  }

  async close() {
    if (this.watcher) { try { this.watcher.close() } catch {} this.watcher = null }
    for (const res of this.clients) { try { res.end() } catch {} }
    this.clients.clear()
    if (this.server) {
      await new Promise((r) => this.server.close(() => r()))
      this.server = null
    }
    this._started = false
  }
}

module.exports = {
  ArtifactServer,
  isArtifactPath,
  pathToArtifactId,
  artifactIdToPath,
  parseArtifactUrl,
  preparePage,
  ARTIFACT_EXTS,
}
