/**
 * Newline-delimited JSON-RPC 2.0 transport over a byte stream pair (the SDK
 * server's stdio channel). One JSON frame per line; a frame with `id`+`method`
 * is an incoming request, `id` alone matches a pending outgoing request, and
 * `method` alone is a notification. Malformed lines are ignored (a resilient
 * wire reader, not a validator); handler failures become JSON-RPC error
 * responses, never a crashed transport.
 *
 * @module @deepseek-ai/dsh-jsonrpc/transport
 */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

type JsonRpcId = string | number
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (method: string, params: Record<string, unknown>) => void

/**
 * The outbound half of a JSON-RPC peer — what {@link HarnessSdkServer} needs
 * to talk BACK to the host: awaited `request`s and fire-and-forget `notify`s.
 * Narrow on purpose so tests substitute a recording fake without a stream pair.
 */
export interface JsonRpcTransportPeer {
  /**
   * Send a request to the remote peer and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @returns the remote peer's `result`; rejects on a JSON-RPC `error`
   * response, a write failure, or transport/input closure.
   */
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  /**
   * Send a notification (no response expected). An omitted `params` sends no
   * `params` member at all.
   * @param method - the JSON-RPC method name.
   * @param params - the optional notification parameters object.
   */
  notify(method: string, params?: Record<string, unknown>): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Line-delimited JSON-RPC 2.0 endpoint over a `Readable`/`Writable` pair.
 * Inert until {@link start} attaches the input listeners; {@link close}
 * detaches them and rejects every pending outgoing request (dispose-safe: the
 * streams themselves are not destroyed — the caller owns them). Incoming
 * requests are dispatched to the single {@link onRequest} handler (a missing
 * handler answers `-32601 method not found`; a throwing handler answers
 * `-32603` with the message); incoming notifications go to {@link
 * onNotification} and are dropped without one.
 */
export class JsonRpcLineTransport implements JsonRpcTransportPeer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  /** Attach the input listeners and begin reading frames. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
  }

  /**
   * Detach the input listeners and reject every pending outgoing request with
   * "JSON-RPC transport closed". Safe to call without a prior {@link start}.
   */
  close(): void {
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.failPending(new Error('JSON-RPC transport closed'))
  }

  /**
   * Install THE handler for incoming requests (a later call replaces it).
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Install THE handler for incoming notifications (a later call replaces it).
   * @param handler - invoked per notification with the method and normalized
   * params object.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Wait until every frame written before this call has reached the output's
   * write callback. The empty queued write is a barrier and emits no protocol
   * bytes.
   * @returns a promise that settles with the output write callback.
   */
  flush(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.output.write('', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    this.drainLines()
  }

  private drainLines(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      void this.handleLine(line)
    }
  }

  private readonly onInputError = (error: Error): void => {
    this.failPending(error)
  }

  private readonly onInputEnd = (): void => {
    this.buffer += this.decoder.end()
    this.drainLines()
    this.failPending(new Error('JSON-RPC input closed'))
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // Swallows ONLY JSON.parse syntax errors: a malformed wire line is a
      // peer bug this resilient reader skips; nothing else runs in the try.
      return
    }
    if (!message || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleIncomingResponse(id, frame)
      return
    }
    if (typeof method === 'string') {
      this.notificationHandler?.(method, objectParams(frame.params))
    }
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.writeError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new Error(typeof error.message === 'string' ? error.message : 'JSON-RPC error'))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

/** Normalize JSON-RPC `params` to a plain object (arrays and scalars collapse to `{}`). */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}
