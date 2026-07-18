// Newline-delimited JSON-RPC 2.0 client. Pure module: takes an outbound
// `write(frame)` sink and receives inbound bytes via `feed(chunk)`. No stream
// or subprocess dependencies here — the transport wires those up. Kept small
// enough to unit-test with node:test.
//
// Wire shape (from packages/ui/jsonrpc/README.md):
//   {"jsonrpc":"2.0","id":<n>,"method":"...","params":{...}}\n
//   {"jsonrpc":"2.0","id":<n>,"result":...}\n
//   {"jsonrpc":"2.0","method":"...","params":{...}}\n       (notification)
// Server may also send inbound requests (future session/interrupt roundtrip);
// we keep a dispatch table so those don't get dropped.

'use strict'

class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

class JsonRpcClient {
  constructor({ write, onNotify, onServerRequest, onProtocolError }) {
    this._write = write
    this._onNotify = onNotify || (() => {})
    // Table of method -> async (params) => result for inbound requests. Any
    // unhandled request replies with method-not-found so the server never hangs.
    this._serverHandlers = onServerRequest || {}
    this._onProtocolError = onProtocolError || ((err) => { console.error('[jsonrpc]', err) })
    this._nextId = 1
    this._pending = new Map()
    this._buf = ''
    this._closed = false
  }

  request(method, params) {
    if (this._closed) return Promise.reject(new Error('client closed'))
    const id = this._nextId++
    const frame = { jsonrpc: '2.0', id, method }
    if (params !== undefined) frame.params = params
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
    })
    try {
      this._write(JSON.stringify(frame) + '\n')
    } catch (err) {
      this._pending.delete(id)
      return Promise.reject(err)
    }
    return promise
  }

  notify(method, params) {
    if (this._closed) return
    const frame = { jsonrpc: '2.0', method }
    if (params !== undefined) frame.params = params
    this._write(JSON.stringify(frame) + '\n')
  }

  // Feed raw bytes from the transport. Splits on newline; the last partial
  // line is buffered until the next chunk.
  feed(chunk) {
    if (this._closed) return
    this._buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let idx
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim()
      this._buf = this._buf.slice(idx + 1)
      if (!line) continue
      this._handleFrame(line)
    }
  }

  // Fail all in-flight requests. Called from the transport when the runtime
  // process dies. The transport is expected to re-spawn and re-issue
  // initialize — pending requests from the old process are not resumable.
  reset(reason) {
    const err = new Error(reason || 'runtime disconnected')
    for (const { reject } of this._pending.values()) reject(err)
    this._pending.clear()
    this._buf = ''
  }

  close() {
    this._closed = true
    this.reset('client closed')
  }

  _handleFrame(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (err) {
      this._onProtocolError(new Error(`bad JSON frame: ${line.slice(0, 200)}`))
      return
    }
    if (msg && typeof msg === 'object' && 'id' in msg && ('result' in msg || 'error' in msg)) {
      // Response.
      const entry = this._pending.get(msg.id)
      if (!entry) {
        this._onProtocolError(new Error(`response for unknown id ${msg.id}`))
        return
      }
      this._pending.delete(msg.id)
      if ('error' in msg && msg.error) {
        entry.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data))
      } else {
        entry.resolve(msg.result)
      }
      return
    }
    if (msg && typeof msg.method === 'string') {
      if ('id' in msg) {
        // Inbound request from server.
        void this._handleServerRequest(msg)
      } else {
        // Notification.
        try {
          this._onNotify(msg.method, msg.params)
        } catch (err) {
          this._onProtocolError(err)
        }
      }
      return
    }
    this._onProtocolError(new Error(`unrecognized frame: ${line.slice(0, 200)}`))
  }

  async _handleServerRequest(msg) {
    const handler = this._serverHandlers[msg.method]
    if (!handler) {
      this._safeWrite(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` }
      }) + '\n')
      return
    }
    try {
      const result = await handler(msg.params)
      this._safeWrite(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }) + '\n')
    } catch (err) {
      this._safeWrite(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32000, message: err.message || String(err) }
      }) + '\n')
    }
  }

  // Write path used from response emitters (server-request answers). The
  // request/notify sites keep their local guards — this exists for the
  // async server-request handler, whose result may land after stop() when
  // the socket has already been destroyed. Report the write failure through
  // the protocol-error channel instead of surfacing an unhandled rejection.
  _safeWrite(frame) {
    if (this._closed) return
    try {
      this._write(frame)
    } catch (err) {
      this._onProtocolError(err)
    }
  }
}

module.exports = { JsonRpcClient, JsonRpcError }
