// Runtime supervisor: connects the shell to a DSH JSON-RPC runtime.
//
// Two modes:
//   - stdio: spawn the jsonrpc-demo bin as a direct child, pipe stdio. The
//     runtime's lifetime *is* the connection.
//   - socket: talk to a long-running daemon over a unix socket. A companion
//     DaemonSupervisor guarantees a daemon is up; SocketTransport carries the
//     JSON-RPC frames. `kill -9` of the daemon shows up here as a socket
//     'exit' event; ensureUp then re-spawns the daemon and we reconnect.
//
// Either way, the shell speaks protocol v2:
//   initialize { cwd, model, protocolVersion: 2, capabilities: { interruptions: true } }
// so a v2 server routes session/interrupt requests to us; v1 servers ignore
// the unknown fields.
//
// Inbound server->client requests (session/interrupt today) fan out via
// `onInterrupt(request)` — the main process wraps that with a promise the UI
// resolves.

'use strict'

const { EventEmitter } = require('node:events')
const { JsonRpcClient } = require('./jsonrpc-client.js')
const { StdioTransport, SocketTransport } = require('./transport.js')
const { DaemonSupervisor } = require('./daemon.js')

const STDIO_BACKOFF_MS = [0, 500, 1500, 4000, 10000]
const SOCKET_RECONNECT_MS = [0, 300, 1000, 2500, 5000]

class RuntimeSupervisor extends EventEmitter {
  // profile: {
  //   mode: 'stdio' | 'daemon',
  //   // stdio-only:
  //   cmd, args, cwd, env,
  //   // daemon-only:
  //   daemon: { cmd, args, cwd, env, socketPath },
  //   model, label,
  //   // v2 protocol negotiation:
  //   protocolVersion: 2, capabilities: { interruptions: true },
  //   // upstream hook:
  //   onInterrupt: async (request) => resolution
  // }
  constructor({ profile }) {
    super()
    this.profile = profile
    this.status = 'idle' // idle | starting | running | crashed | respawning | dead
    this.transport = null
    this.client = null
    this.daemon = null
    this.serverInfo = null
    this.serverCapabilities = null
    this._respawnCount = 0
    this._stopping = false
    this._onInterrupt = profile.onInterrupt || null
  }

  async start() {
    this._stopping = false
    this._respawnCount = 0
    if (this.profile.mode === 'daemon') {
      this.daemon = new DaemonSupervisor(this.profile.daemon)
      this.daemon.on('stderr', (s) => this.emit('stderr', s))
      this.daemon.on('error', (err) => this.emit('protocolError', err))
      this.daemon.on('down', (info) => {
        // The daemon vanished. If we're not stopping, ensureUp+reconnect on the
        // next _spawnOnce cycle. We don't force-reconnect here — the socket
        // 'exit' handler already schedules that.
        this.emit('stderr', `daemon exited (code=${info.code} signal=${info.signal})\n`)
      })
      await this.daemon.ensureUp()
    }
    await this._spawnOnce()
  }

  async _spawnOnce() {
    this._setStatus(this._respawnCount === 0 ? 'starting' : 'respawning')
    // Reset any stale handshake info from the previous incarnation. If the
    // new initialize fails and we surface serverInfo to the UI, it must not
    // still be showing the crashed process's identity.
    this.serverInfo = null
    this.serverCapabilities = null

    if (this.profile.mode === 'daemon') {
      // Make sure a daemon is answering before we try to connect. This is the
      // path exercised on kill -9: probe fails, ensureUp re-spawns, we get a
      // fresh socket path back.
      await this.daemon.ensureUp()
      this.transport = new SocketTransport({ socketPath: this.profile.daemon.socketPath })
    } else {
      this.transport = new StdioTransport({
        cmd: this.profile.cmd,
        args: this.profile.args,
        cwd: this.profile.cwd,
        env: this.profile.env || {},
      })
    }

    const t = this.transport
    const client = new JsonRpcClient({
      write: (frame) => { try { t.write(frame) } catch (err) { this.emit('protocolError', err) } },
      onNotify: (method, params) => this.emit('notify', method, params),
      onServerRequest: {
        'session/interrupt': (params) => this._handleInterrupt(params),
      },
      onProtocolError: (err) => this.emit('protocolError', err),
    })
    this.client = client

    t.on('data', (chunk) => client.feed(chunk))
    t.on('stderr', (line) => this.emit('stderr', line))
    t.on('spawnError', (err) => this.emit('protocolError', err))
    t.on('exit', ({ code, signal, stderrTail }) => this._onExit({ code, signal, stderrTail }))

    t.start()

    // Handshake. protocol v2 params — v1 servers ignore the extra fields.
    try {
      const info = await client.request('initialize', {
        cwd: this.profile.cwd || (this.profile.daemon && this.profile.daemon.cwd),
        model: this.profile.model,
        protocolVersion: this.profile.protocolVersion || 2,
        capabilities: this.profile.capabilities || { interruptions: true },
      })
      this.serverInfo = info && info.serverInfo
      this.serverCapabilities = (info && info.capabilities) || null
      this._setStatus('running')
      this.emit('initialized', info)
    } catch (err) {
      this.emit('protocolError', err)
    }
  }

  async _handleInterrupt(params) {
    if (!this._onInterrupt) {
      // Client capability says interruptions:true but the shell hasn't wired
      // a handler yet — fail closed (cancelled), matching the fail-closed
      // policy on the server side.
      return { outcome: 'cancelled' }
    }
    try {
      const result = await this._onInterrupt(params)
      if (!result || !result.outcome) return { outcome: 'cancelled' }
      return result
    } catch (_err) {
      return { outcome: 'cancelled' }
    }
  }

  async prompt({ sessionId, contentBlocks }) {
    if (!this.client) throw new Error('runtime not started')
    return this.client.request('session/prompt', { sessionId, contentBlocks })
  }

  async request(method, params) {
    if (!this.client) throw new Error('runtime not started')
    return this.client.request(method, params)
  }

  async stop() {
    this._stopping = true
    if (this.client) {
      try {
        await Promise.race([
          this.client.request('shutdown'),
          new Promise((r) => setTimeout(r, 1000)),
        ])
      } catch (_) { /* runtime may already be gone */ }
      this.client.close()
    }
    if (this.transport) this.transport.stop()
    // In daemon mode, also shut down the daemon child we spawned.
    if (this.daemon) await this.daemon.stop()
    this._setStatus('dead')
  }

  _onExit({ code, signal, stderrTail }) {
    if (this.client) this.client.reset('runtime exited')
    if (this._stopping) {
      this._setStatus('dead')
      return
    }
    this._setStatus('crashed')
    this.emit('crash', { code, signal, stderrTail })
    // Backoff schedule differs: socket reconnect is fast (daemon should be
    // there already or getting there), stdio re-spawn is slower (whole
    // process boot).
    const schedule = this.profile.mode === 'daemon' ? SOCKET_RECONNECT_MS : STDIO_BACKOFF_MS
    const delay = schedule[Math.min(this._respawnCount, schedule.length - 1)]
    this._respawnCount += 1
    setTimeout(() => { void this._spawnOnce().catch((err) => this.emit('protocolError', err)) }, delay).unref()
  }

  _setStatus(next) {
    if (this.status === next) return
    this.status = next
    this.emit('status', next)
  }
}

module.exports = { RuntimeSupervisor }
