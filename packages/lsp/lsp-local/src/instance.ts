/**
 * One language-server instance: a connection plus the initialize handshake, the serialized abortable
 * query queue, the transient `didOpen`→request→`didClose` lifecycle, and bounded teardown. One
 * instance owns one `(provider id, canonical workspace)` process. Queries serialize through a single
 * queue so a cancellation that fails to stop the server can terminate it without killing unrelated
 * work; distinct instances run in parallel.
 * @module @deepseek-ai/dsh-lsp-local/instance
 */

import { pathToFileURL } from 'node:url'
import type {
  LspOperation,
  LspProviderQuery,
  LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { LspConnection } from './connection.ts'
import type { ConnectionSpec } from './connection.ts'
import { readHostSource } from './host.ts'
import type { WireInitializeResult, WireServerCapabilities } from './protocol.ts'
import {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'

/** Everything an instance needs beyond the connection spec. */
export interface InstanceSpec extends ConnectionSpec {
  /** Static `initialize` options forwarded to the server. */
  readonly initializationOptions: unknown
  /** Largest source file this host will open (bytes). */
  readonly maxDocumentBytes: number
  /** Graceful `shutdown`/`exit` budget before escalation (ms). */
  readonly shutdownTimeoutMs: number
  /** SIGTERM→SIGKILL grace after graceful shutdown fails (ms). */
  readonly killGraceMs: number
}

/**
 * A single initialized server process. Not exported as a provider — the provider single-flights and
 * pools these. `query()` serializes; `dispose()` rejects queued work and tears the process down.
 */
export class LspInstance {
  private readonly connection: LspConnection
  private capabilities: WireServerCapabilities | undefined
  /** The serialization tail: each query awaits the prior one, so lifecycles never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** Set once the process closes, so the pool can synchronously skip a dead instance. */
  private processClosed = false
  /** Populated once `initialize` succeeds; a failed handshake rejects every query. */
  private readonly ready: Promise<void>

  /**
   * @param spec - the launch, initialize, and teardown parameters.
   */
  constructor(private readonly spec: InstanceSpec) {
    this.connection = new LspConnection(spec, (method, params) => this.answerServerRequest(method, params))
    this.ready = this.initialize()
    // A handshake rejection must not surface as an unhandled rejection before the first query awaits
    // it; queries attach the real handler.
    this.ready.catch(() => {})
    void this.connection.closed.then(() => { this.processClosed = true })
  }

  /** Synchronous liveness check: true once the process has closed or the instance was disposed. */
  get dead(): boolean {
    return this.processClosed || this.disposed
  }

  /**
   * Run one query through the serialized queue.
   * @param request - the resolved provider query.
   * @param signal - optional cancellation for this query's full lifecycle.
   * @returns the normalized result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    const run = this.queue.then(() => this.runQuery(request, signal))
    // Keep the tail alive regardless of this query's outcome so the next caller still serializes.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async initialize(): Promise<void> {
    const initializeResult = await this.connection.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.spec.cwd).href,
      workspaceFolders: [{ uri: pathToFileURL(this.spec.cwd).href, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions,
    }) as WireInitializeResult
    const capabilities = initializeResult.capabilities
    // An omitted encoding defaults to utf-16; any other value is a protocol error we reject here.
    negotiatePositionEncoding(capabilities.positionEncoding)
    this.capabilities = capabilities
    this.connection.notify('initialized', {})
  }

  private async runQuery(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new Error('LSP instance was disposed')
    if (signal?.aborted) throw abortError(signal)
    await this.ready
    const capabilities = this.capabilities
    /* v8 ignore next -- `ready` resolves only after capabilities are set, else it rejects above; defensive. */
    if (capabilities === undefined) throw new Error('LSP instance is not initialized')
    if (!supportsOperation(capabilities, request.operation)) {
      throw new Error(`server does not support ${request.operation}`)
    }
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new Error('server does not support the transient textDocument/didOpen this host requires')
    }

    const source = await readHostSource(request.filePath, this.spec.cwd, this.spec.maxDocumentBytes)
    const uri = pathToFileURL(source.canonicalPath).href
    let opened = false
    try {
      if (signal?.aborted) throw abortError(signal)
      this.connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: request.languageId, version: 1, text: source.text },
      })
      opened = true
      const payload = await this.sendRequest(request.operation, uri, request.position, signal)
      return this.normalize(request.operation, payload)
    } finally {
      if (opened) {
        try {
          this.connection.notify('textDocument/didClose', { textDocument: { uri } })
        } catch (error) {
          /* v8 ignore start -- stdin write errors surface asynchronously via the swallowed 'error'
             listener, so a synchronous didClose write failure is a defensive path. */
          // A close-write failure does not replace the settled result/error, but the instance can no
          // longer be trusted: invalidate it and await bounded process termination.
          this.disposed = true
          void this.tearDown(error instanceof Error ? error : new Error(String(error)))
          /* v8 ignore stop */
        }
      }
    }
  }

  private async sendRequest(
    operation: LspOperation,
    uri: string,
    position: LspProviderQuery['position'],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const params = {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
      // references always includes declarations: the caller gets no flag and impact analysis never
      // omits the defining site.
      ...(operation === 'references' ? { context: { includeDeclaration: true } } : {}),
    }
    const requestId = this.connection.peekNextId()
    const send = this.connection.request(requestMethod(operation), params)
    if (signal === undefined) return send
    return this.raceAbort(send, requestId, signal)
  }

  /** Race a pending request against abort; on abort, send `$/cancelRequest` and reject. */
  private async raceAbort(send: Promise<unknown>, requestId: number, signal: AbortSignal): Promise<unknown> {
    const abort = new Promise<never>((_, reject) => {
      const onAbort = (): void => { reject(abortError(signal)) }
      /* v8 ignore next -- runQuery checks signal.aborted before sending, so it is not yet aborted here; defensive. */
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      // Remove the abort listener once the request settles either way; the finally-promise inherits
      // send's rejection, so catch it to avoid an unhandled rejection when abort already won.
      send.finally(() => { signal.removeEventListener('abort', onAbort) }).catch(() => {})
    })
    try {
      return await Promise.race([send, abort])
    } catch (error) {
      if (signal.aborted) this.connection.cancel(requestId)
      throw error
    }
  }

  private normalize(operation: LspOperation, payload: unknown): LspQueryResult {
    if (operation === 'hover') {
      return { kind: 'hover', hover: normalizeHover(payload) }
    }
    return { kind: 'locations', locations: normalizeLocations(payload) }
  }

  private answerServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'workspace/configuration') {
      // Answer every requested item with the one static configuration value.
      const record = params as { items?: unknown[] } | null
      /* v8 ignore next -- a configuration request always carries an items array; the empty fallback is defensive. */
      const items = Array.isArray(record?.items) ? record.items : []
      return Promise.resolve(items.map(() => this.spec.configuration))
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      // Accept lifecycle bookkeeping requests with an empty result; we register nothing dynamic.
      return Promise.resolve(null)
    }
    if (method === 'workspace/applyEdit') {
      // This host never applies edits or runs commands.
      return Promise.reject(new Error('workspace/applyEdit is not permitted by this host'))
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`))
  }

  /**
   * Reject queued work, attempt graceful `shutdown`/`exit`, then escalate SIGTERM→SIGKILL, awaiting
   * process close so nothing outlives disposal.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.connection.closed
      return
    }
    this.disposed = true
    await this.tearDown(new Error('LSP instance disposed'))
  }

  private async tearDown(_reason: Error): Promise<void> {
    try {
      using shutdownDeadline = deadline(undefined, this.spec.shutdownTimeoutMs, 'LSP_SHUTDOWN')
      await this.gracefulShutdown(shutdownDeadline.signal)
    } catch {
      // Graceful shutdown failed or timed out: fall through to signal escalation.
    }
    await this.forceTerminate()
  }

  /** Best-effort LSP `shutdown` request then `exit` notification, bounded by `signal`. */
  private async gracefulShutdown(signal: AbortSignal): Promise<void> {
    const shutdown = this.connection.request('shutdown', null)
    await Promise.race([
      shutdown,
      new Promise<never>((_, reject) => {
        /* v8 ignore next -- the shutdown deadline signal is freshly armed and not yet aborted here; defensive. */
        if (signal.aborted) { reject(abortError(signal)); return }
        signal.addEventListener('abort', () => { reject(abortError(signal)) }, { once: true })
      }),
    ])
    this.connection.notify('exit', null)
  }

  /** SIGTERM, wait `killGraceMs` for close, then SIGKILL; await full process close either way. */
  private async forceTerminate(): Promise<void> {
    this.connection.terminate()
    using graceDeadline = deadline(undefined, this.spec.killGraceMs, 'LSP_KILL_GRACE')
    const closedInTime = await Promise.race([
      this.connection.closed.then(() => true),
      new Promise<boolean>((resolve) => {
        /* v8 ignore next -- the kill-grace deadline signal is freshly armed and not yet aborted here; defensive. */
        if (graceDeadline.signal.aborted) { resolve(false); return }
        graceDeadline.signal.addEventListener('abort', () => { resolve(false) }, { once: true })
      }),
    ])
    if (!closedInTime) this.connection.kill()
    await this.connection.closed
  }
}

/** Server→client request methods this host acknowledges with an empty result (no dynamic registration). */
const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

/** Build an abort Error carrying the signal's reason (preserving a timeout classification). */
function abortError(signal: AbortSignal): Error {
  const timeout = timeoutOf(signal)
  if (timeout !== undefined) return timeout
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error('LSP query aborted')
}

/**
 * The client capabilities advertised at `initialize`: UTF-16 positions, workspace folders and
 * configuration, markdown/plaintext hover, and link support for definition/implementation. No
 * dynamic registration; the server's returned capabilities are authoritative.
 */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const
