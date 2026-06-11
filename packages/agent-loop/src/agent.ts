import type { Context } from 'cordis'
import type { AgentOptions, AgentStatus, SendOptions } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { Inbox } from './inbox.ts'
import { runLoop } from './loop.ts'

/**
 * The concrete {@link Agent} implementation owned by the agent-loop plugin.
 *
 * Owns the inbox (queued + steering FIFOs), the per-step AbortController, and
 * the loop driver. Everything observable happens through session events and
 * the agent/* event taxonomy — plugins never need this class.
 */
export class LoopAgent implements Agent {
  readonly inbox = new Inbox()

  private _status: AgentStatus = 'idle'
  private currentAbort: AbortController | undefined
  private disposed: Promise<void>
  private resolveDisposed!: () => void
  /** Resolves when the driver loop has fully exited (tests/disposal). */
  done: Promise<void> = Promise.resolve()

  constructor(
    private ctx: Context,
    public readonly id: string,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.disposed = promise
    this.resolveDisposed = resolve
  }

  get status(): AgentStatus {
    return this._status
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === status || this._status === 'disposed') return
    this._status = status
    this.ctx.emit('agent/status', this, status)
  }

  send(content: ContentBlock[], options?: SendOptions): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    const source = options?.source ?? { kind: 'user' as const }
    this.inbox.enqueue({ content, source })
    this.ctx.emit('agent/queued', this, content, { ...options, steering: false })
  }

  steer(content: ContentBlock[], options?: SendOptions): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    if (this._status !== 'running') return this.send(content, options)
    const source = options?.source ?? { kind: 'user' as const }
    this.inbox.steer({ content, source })
    this.ctx.emit('agent/queued', this, content, { ...options, steering: true })
  }

  inject(content: ContentBlock[], options?: SendOptions): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    const source = options?.source ?? { kind: 'user' as const }
    this.session.append('context/message', { content, source })
  }

  abort(reason?: string): void {
    this.currentAbort?.abort(reason ?? 'aborted')
  }

  /** Start the driver loop. Returns a disposer that stops it. */
  start(): () => void {
    this.done = runLoop(this.ctx, this, {
      setStatus: status => this.setStatus(status),
      setAbort: controller => void (this.currentAbort = controller),
      disposed: this.disposed,
      isDisposed: () => this._status === 'disposed',
    })
    return () => {
      this._status = 'disposed'
      this.resolveDisposed()
      this.currentAbort?.abort('disposed')
    }
  }
}
