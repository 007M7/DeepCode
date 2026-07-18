// Daemon lifecycle helper. Owns:
//   - probing the daemon over a scratch socket connection (daemon/ping),
//   - spawning the daemon bin when the probe says "nobody home",
//   - waiting for the socket file to appear so a first connect doesn't race.
//
// This is *separate* from the SocketTransport that serves the long-lived
// JSON-RPC session: probing uses a one-shot net.createConnection + newline
// JSON-RPC frame; the transport uses a fresh connection once we know a daemon
// is answering.
//
// The daemon child (dsh-daemon-demo bin) is treated as a supervised sibling —
// we spawn it, keep pid, log stderr, and re-spawn it on unexpected exit while
// the shell wants a daemon connection. `kill -9` on the daemon looks like
// {exit:{code:null,signal:'SIGKILL'}} here; the supervisor uses that as the
// trigger to lockfile-check + re-spawn.

'use strict'

const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const net = require('node:net')
const { EventEmitter } = require('node:events')

const PROBE_TIMEOUT_MS = 750
const SOCKET_WAIT_TIMEOUT_MS = 4000
const SOCKET_WAIT_INTERVAL_MS = 60

// One-shot daemon/ping. Resolves with the ping result on success, or `null`
// when the socket is absent/refuses/times out — that's the "spawn a daemon"
// signal.
function probeDaemon(socketPath) {
  return new Promise((resolve) => {
    if (!existsSync(socketPath)) return resolve(null)
    const sock = net.createConnection(socketPath)
    let settled = false
    let buf = ''
    const done = (v) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch (_) { /* ignore */ }
      resolve(v)
    }
    const timeout = setTimeout(() => done(null), PROBE_TIMEOUT_MS)
    timeout.unref()
    sock.on('connect', () => {
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon/ping' }) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      const line = buf.slice(0, idx).trim()
      clearTimeout(timeout)
      try {
        const msg = JSON.parse(line)
        if (msg && msg.result) return done(msg.result)
        return done(null)
      } catch (_) { return done(null) }
    })
    sock.on('error', () => { clearTimeout(timeout); done(null) })
    sock.on('close', () => { clearTimeout(timeout); done(null) })
  })
}

async function waitForSocket(socketPath, deadlineMs = SOCKET_WAIT_TIMEOUT_MS) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (existsSync(socketPath)) return true
    await new Promise((r) => setTimeout(r, SOCKET_WAIT_INTERVAL_MS))
  }
  return false
}

// Supervise the daemon bin. `spec` is
//   { cmd, args, cwd, env, socketPath }.
// Emits:
//   'up'   — daemon is confirmed responding on the socket
//   'down' — process exited, we plan to re-spawn (unless stopping)
//   'stderr' — last stderr chunk (for the status bar)
//   'error' — spawn error
class DaemonSupervisor extends EventEmitter {
  constructor(spec) {
    super()
    this.spec = spec
    this.child = null
    this.pid = null
    this.stderrTail = ''
    this._stopping = false
    this._attempts = 0
  }

  // Idempotent: ensure a daemon is up on this.spec.socketPath. Returns the
  // ping result. May spawn a new child process. Retries on failure with a
  // small backoff so kill -9 followed by a quick reconnect works.
  async ensureUp() {
    this._stopping = false
    let attempt = 0
    let lastErr = null
    while (attempt < 5) {
      const ping = await probeDaemon(this.spec.socketPath)
      if (ping) {
        this._attempts = 0
        this.emit('up', ping)
        return ping
      }
      // Nobody home. Spawn.
      try {
        this._spawnChild()
      } catch (err) {
        lastErr = err
        attempt += 1
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      const appeared = await waitForSocket(this.spec.socketPath)
      if (!appeared) {
        lastErr = new Error(`daemon socket did not appear at ${this.spec.socketPath}`)
        attempt += 1
        continue
      }
      const p2 = await probeDaemon(this.spec.socketPath)
      if (p2) {
        this._attempts = 0
        this.emit('up', p2)
        return p2
      }
      lastErr = new Error('daemon spawned but ping failed')
      attempt += 1
      await new Promise((r) => setTimeout(r, 300))
    }
    const err = lastErr || new Error('daemon ensureUp exhausted retries')
    this.emit('error', err)
    throw err
  }

  _spawnChild() {
    if (this.child) return // already running under our management
    // stdio: 'pipe' on all three streams matches the integration-smoke that
    // ships in the daemon branch (see integration-smoke.mjs). With
    // stdio:'ignore' on stdin the daemon exits cleanly at code=0 with no
    // output — the tsx `--import` loader appears to short-circuit before
    // installFailLoud registers, so we lose the diagnostic. Using an open
    // pipe on stdin avoids that path.
    const child = spawn(this.spec.cmd, this.spec.args, {
      cwd: this.spec.cwd,
      env: { ...process.env, ...(this.spec.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    })
    this.child = child
    this.pid = child.pid
    child.on('error', (err) => this.emit('error', err))
    child.stdout.on('data', () => { /* daemon has no stdout protocol; drop */ })
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + s).slice(-4096)
      this.emit('stderr', s)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      const wasStopping = this._stopping
      this.emit('down', { code, signal, stderrTail: this.stderrTail, planned: wasStopping })
    })
  }

  async stop() {
    this._stopping = true
    if (!this.child) return
    const c = this.child
    try { c.kill('SIGTERM') } catch (_) { /* already dying */ }
    // Give it 1.5s to clean up (unlinks socket + lockfile), then SIGKILL.
    setTimeout(() => { if (c && !c.killed) { try { c.kill('SIGKILL') } catch (_) {} } }, 1500).unref()
    // Wait for exit so the caller can assume the socket is unlinked.
    await new Promise((resolve) => {
      if (!this.child) return resolve()
      this.child.once('exit', () => resolve())
    })
  }
}

module.exports = { DaemonSupervisor, probeDaemon, waitForSocket }
