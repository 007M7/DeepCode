// Transport interface for the DSH runtime. Two implementations live here:
//
//   - StdioTransport: Phase 1 — spawns the jsonrpc-demo bin directly, pipes
//     stdio. Same shape as the Python SDK's runtime bridge.
//   - SocketTransport: Phase 2 — connects a Unix domain socket served by a
//     long-running daemon. Idle-reconnect is caller-driven (see the daemon
//     supervisor); this class only owns one connection at a time.
//
// A transport exposes: start(), stop(), on('data'|'exit'|'spawnError', cb),
// write(frame). The JsonRpcClient consumes `write` and calls `.feed()` from
// the 'data' listener.

'use strict'

const { spawn } = require('node:child_process')
const net = require('node:net')
const { EventEmitter } = require('node:events')

class StdioTransport extends EventEmitter {
  constructor({ cmd, args, cwd, env }) {
    super()
    this.cmd = cmd
    this.args = args
    this.cwd = cwd
    this.env = env
    this.child = null
    this._stderrTail = ''
  }

  start() {
    this.child = spawn(this.cmd, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.on('error', (err) => this.emit('spawnError', err))
    this.child.stdout.on('data', (chunk) => this.emit('data', chunk))
    this.child.stderr.on('data', (chunk) => {
      // Keep the last ~4KB of stderr — surfaces load failures to the UI when
      // the runtime dies without an exit code path.
      const s = chunk.toString('utf8')
      this._stderrTail = (this._stderrTail + s).slice(-4096)
      this.emit('stderr', s)
    })
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal, stderrTail: this._stderrTail })
      this.child = null
    })
  }

  write(frame) {
    // Dead-stdin guard (2026-07-18): if the child has already exited (config
    // schema drift, missing api key, spawn ENOENT), stdin.writable is false.
    // Throwing here would race the exit handler — protocolError with a bland
    // "runtime not writable" would beat the exit-driven crash → stderrTail
    // scan that surfaces the actual cause (e.g. `llm-deepseek: an API key is
    // required`). The write is meaningless anyway once the child is gone;
    // silently drop it and let the exit path fire so the classifier sees the
    // real error. Emit as `dropped` so tests + verbose logs can observe it.
    if (!this.child || !this.child.stdin.writable) {
      this.emit('dropped', frame)
      return
    }
    this.child.stdin.write(frame)
  }

  stop() {
    if (!this.child) return
    try { this.child.stdin.end() } catch (_) { /* pipe already closed */ }
    // Give the runtime a moment to dispose gracefully via stdin EOF; hard-kill
    // if it hasn't gone by then.
    const c = this.child
    setTimeout(() => { if (c && !c.killed) c.kill('SIGTERM') }, 1500).unref()
  }
}

// Connect to a long-running daemon over a Unix socket. Emits 'connected' on
// TCP-style handshake, 'data' on inbound bytes, 'exit' when the daemon closes
// the socket (the supervisor treats that as "daemon gone, reconnect"), and
// 'spawnError' on connection error before 'connect'.
class SocketTransport extends EventEmitter {
  constructor({ socketPath }) {
    super()
    this.socketPath = socketPath
    this.sock = null
    this._connected = false
  }

  start() {
    const sock = net.createConnection(this.socketPath)
    this.sock = sock
    sock.on('connect', () => {
      this._connected = true
      this.emit('connected')
    })
    sock.on('data', (chunk) => this.emit('data', chunk))
    sock.on('error', (err) => {
      // A connection error before 'connect' is a spawn failure (the socket
      // isn't there or the daemon rejected us); after 'connect' it's an
      // in-flight IO error and the socket will close right after.
      if (!this._connected) this.emit('spawnError', err)
      else this.emit('stderr', `socket error: ${err.message}`)
    })
    sock.on('close', () => {
      this.emit('exit', { code: 0, signal: null, stderrTail: '' })
      this.sock = null
      this._connected = false
    })
  }

  write(frame) {
    // Symmetric dead-socket guard to StdioTransport.write above. If the
    // daemon vanished, `close` on the socket will fire an `exit` and the
    // supervisor will reconnect on the next tick; throwing here would race
    // that path with a bland banner. Drop and let exit-driven recovery win.
    if (!this.sock || this.sock.destroyed) {
      this.emit('dropped', frame)
      return
    }
    this.sock.write(frame)
  }

  stop() {
    if (this.sock) {
      try { this.sock.end() } catch (_) { /* already closed */ }
    }
  }
}

module.exports = { StdioTransport, SocketTransport }
