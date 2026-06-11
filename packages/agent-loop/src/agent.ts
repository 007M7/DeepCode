/**
 * The concrete Agent implementation: LoopAgent plus its inbox. Everything
 * observable happens through session events and the agent/* event taxonomy —
 * plugins never need this class.
 *
 * @module dsh-agent-loop/agent
 */

import type { Context } from 'cordis'
import type { AgentId, AgentOptions, AgentStatus, SendOptions } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
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
    public readonly id: AgentId,
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

  private resolveSource(options?: SendOptions): MessageSource {
    return options?.source ?? { kind: 'user' }
  }

  send(content: ContentBlock[], options?: SendOptions): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    const source = this.resolveSource(options)
    this.inbox.enqueue({ content, source })
    this.ctx.emit('agent/queued', this, content, { source, steering: false })
  }

  steer(content: ContentBlock[], options?: SendOptions): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    if (this._status !== 'running') { this.send(content, options); return }
    const source = this.resolveSource(options)
    this.inbox.steer({ content, source })
    this.ctx.emit('agent/queued', this, content, { source, steering: true })
  }

  inject(content: ContentBlock[], options?: SendOptions): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    this.session.append('context/message', { content, source: this.resolveSource(options) })
  }

  abort(reason?: string): void {
    this.currentAbort?.abort(reason ?? 'aborted')
  }

  /**
   * Start the driver loop. Returns a disposer: calling it sets status to
   * `disposed`, emits `agent/status('disposed')`, resolves the disposed
   * promise (unblocking the idle wait), and aborts the current request if
   * any. The returned `agent.done` promise resolves once the loop exits.
   */
  start(): () => void {
    this.done = runLoop(this.ctx, this, {
      setStatus: (status) => { this.setStatus(status) },
      setAbort: controller => void (this.currentAbort = controller),
      disposed: this.disposed,
      isDisposed: () => this._status === 'disposed',
    })
    // The disposer must be infallible: it runs inside the fiber's LIFO
    // disposal chain, where a throw would skip later disposers (e.g. the
    // registry unregistration) and leave `done` pending forever.
    return () => {
      if (this._status === 'disposed') return
      this._status = 'disposed'
      this.resolveDisposed()
      this.currentAbort?.abort('disposed')
      // setStatus refuses transitions out of 'disposed', so emit directly —
      // 'disposed' is part of the agent/status contract. Guarded: a throwing
      // listener must not break the disposal chain.
      try {
        this.ctx.emit('agent/status', this, 'disposed')
      } catch {
        // listener error during disposal — nothing safe left to do with it
      }
    }
  }
}
