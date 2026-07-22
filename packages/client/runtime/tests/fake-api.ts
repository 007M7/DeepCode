// Test-local programmable IApiClient fake (NOT the fixture: fixture is a demo
// data source on a real clock; behavior tests need per-case responses and
// deferred-controlled timing). Streams are hand pumps: pushMux/pushHost.
import type {
  HostFrame, IApiClient, MuxFrame, RpcError, RpcRequest, RpcResponse, SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/** Test-held settlement: the case decides when an RPC lands (history-pending injections etc.). */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let nextRpc = 0

export function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: RpcId(`fake-${nextRpc++}`), result: { ok: true, value } }
}

export function err<T>(error: RpcError): RpcResponse<T> {
  return { rpcId: RpcId(`fake-${nextRpc++}`), result: { ok: false, error } }
}

type StreamItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' } | { kind: 'fail'; error: unknown }

interface StreamConn<F> {
  feed(item: StreamItem<F>): void
}

export class FakeApiClient implements IApiClient {
  /** Chronological call record: [method, payload]. */
  readonly calls: { method: string; payload: unknown }[] = []

  // Programmable slots (defaults answer OK-empty); reassign per case.
  onList: (payload: unknown) => Promise<RpcResponse<{ items: never[] }>> = () => Promise.resolve(ok({ items: [] }))
  onCreate: (payload: unknown) => Promise<RpcResponse<{ sessionId: SessionId }>> = () => Promise.resolve(ok({ sessionId: 'fk-new' as SessionId }))
  onHistory: (payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number })
  => Promise<RpcResponse<{ events: never[]; hasMore: boolean }>> =
    () => Promise.resolve(ok({ events: [], hasMore: false }))

  onPrompt: (payload: unknown) => Promise<RpcResponse<{ accepted: true }>> = () => Promise.resolve(ok({ accepted: true as const }))
  onCancel: (payload: unknown) => Promise<RpcResponse<{ accepted: true }>> = () => Promise.resolve(ok({ accepted: true as const }))
  onDescribe: (payload: unknown) => Promise<RpcResponse<{ version: string; cwd: string; attachedSessions: number }>> =
    () => Promise.resolve(ok({ version: '0-fake', cwd: '/f', attachedSessions: 0 }))

  private readonly muxConns: StreamConn<MuxFrame>[] = []
  private readonly hostConns: StreamConn<HostFrame>[] = []

  // Parameters carry local structural annotations: the CI lint lane runs
  // without built lib/, so IApiClient's indexed-access types collapse to any
  // and inferred parameters would trip no-unsafe-argument.
  readonly sessions: IApiClient['sessions'] = {
    list: (payload: unknown) => this.record('session.list', payload, this.onList(payload)),
    create: (payload: unknown) => this.record('session.create', payload, this.onCreate(payload)),
    history: (payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }) =>
      this.record('session.history', payload, this.onHistory(payload)),
    prompt: (payload: unknown) => this.record('session.prompt', payload, this.onPrompt(payload)),
    cancel: (payload: unknown) => this.record('session.cancel', payload, this.onCancel(payload)),
  }

  readonly host: IApiClient['host'] = {
    describe: (payload: unknown) => this.record('host.describe', payload, this.onDescribe(payload)),
  }

  /** When true, streams never fire onOpen (misbehaving-carrier material for the handshake timeout guard). */
  suppressStreamOpen = false

  /** When true, onOpen callbacks are parked instead of fired; releaseStreamOpens() fires them.
   *  Lets a case hold the readiness handshake open (describe done, streams not yet "established"). */
  holdStreamOpen = false
  private heldOpens: (() => void)[] = []

  releaseStreamOpens(): void {
    const held = this.heldOpens
    this.heldOpens = []
    for (const fire of held) fire()
  }

  readonly events: IApiClient['events'] = {
    mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => this.openStream(this.muxConns, signal, onOpen),
    host: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => this.openStream(this.hostConns, signal, onOpen),
  }

  respond(): Promise<{ accepted: false; reason: 'not-pending' }> {
    return Promise.resolve({ accepted: false, reason: 'not-pending' })
  }

  /** Push one mux frame to every open mux stream (rpcId minted unless pinned by the case). */
  pushMux(frame: MuxFrame, rpcId?: string): void {
    for (const conn of [...this.muxConns]) conn.feed({ kind: 'frame', envelope: { rpcId: RpcId(rpcId ?? `push-${nextRpc++}`), payload: frame } })
  }

  pushHost(frame: HostFrame, rpcId?: string): void {
    for (const conn of [...this.hostConns]) conn.feed({ kind: 'frame', envelope: { rpcId: RpcId(rpcId ?? `push-${nextRpc++}`), payload: frame } })
  }

  /** End (clean close) or fail (throw) every open stream — reconnect-path material. */
  endStreams(): void {
    for (const conn of [...this.muxConns, ...this.hostConns]) conn.feed({ kind: 'end' })
  }

  failStreams(error: unknown): void {
    for (const conn of [...this.muxConns, ...this.hostConns]) conn.feed({ kind: 'fail', error })
  }

  get openMuxCount(): number {
    return this.muxConns.length
  }

  callsOf(method: string): unknown[] {
    return this.calls.filter(c => c.method === method).map(c => c.payload)
  }

  private record<T>(method: string, payload: unknown, response: Promise<T>): Promise<T> {
    this.calls.push({ method, payload })
    return response
  }

  private async *openStream<F>(registry: StreamConn<F>[], signal: AbortSignal, onOpen?: () => void): AsyncGenerator<RpcRequest<F>> {
    const inbox: StreamItem<F>[] = []
    let wake: (() => void) | null = null
    const conn: StreamConn<F> = {
      feed: (item) => {
        inbox.push(item)
        wake?.()
      },
    }
    registry.push(conn)
    if (this.holdStreamOpen && onOpen !== undefined) this.heldOpens.push(onOpen)
    else if (!this.suppressStreamOpen) onOpen?.()
    try {
      while (!signal.aborted) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem<F>
          if (item.kind === 'end') return
          if (item.kind === 'fail') throw item.error
          yield item.envelope
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        wake = null
      }
    } finally {
      registry.splice(registry.indexOf(conn), 1)
    }
  }
}
