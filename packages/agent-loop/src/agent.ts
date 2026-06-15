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
import { isTurnOpen, lastTurnNumber, runLoop } from './loop.ts'

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
    const source = this.resolveSource(options)
    if (isTurnOpen(this.session)) {
      // A turn is open in the LOG (decided from the log, not agent status —
      // status can be `running` with no turn open): the context/message is
      // turn-enclosed by that turn, so append it directly.
      this.session.append('context/message', { content, source })
      return
    }
    // No turn open: wrap the injection in a one-shot turn so every event stays
    // turn-enclosed (the durability/replay boundary is the turn).
    const turn = lastTurnNumber(this.session) + 1
    // Once turn/start enters the log, a turn/end is OWED no matter what — even
    // if a throwing `session/event` listener escapes from the turn/start append
    // (Session.append pushes the event BEFORE notifying listeners) or the
    // context/message append throws (non-serializable content, throwing
    // listener). The finally re-checks the log via isTurnOpen() and closes the
    // turn if one was actually opened, so the log never carries a permanently
    // open injection turn that would corrupt later turns/replay. (If the
    // turn/start append throws BEFORE pushing — non-serializable trigger, which
    // can't happen for our fixed trigger — no turn was opened and none is owed.)
    let turnRecorded = false
    try {
      this.session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
      this.session.append('context/message', { content, source })
    } finally {
      // A turn was recorded iff turn/start made it into the log. Close it and
      // mark it for the durability checkpoint below — which must run even when
      // an append's listener threw (the turn is balanced and in memory, so it
      // still needs a flush or a crash before the next turn/dispose loses it).
      if (isTurnOpen(this.session)) {
        this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
        turnRecorded = true
      }
      // Checkpoint the one-shot turn for durability, exactly as the loop does at
      // every turn/end. The loop is NOT running (we are idle), so nothing else
      // will flush this turn. Fire-and-forget with error containment: inject()
      // is synchronous, and a persistence backend failing must not throw into
      // the caller (e.g. a tool-bash task-done callback). Disposal still drains
      // independently, so a slow flush is safe. In the finally so it also runs
      // when an append's listener threw (the turn is still balanced + durable).
      if (turnRecorded) {
        void Promise.resolve(this.ctx.parallel('session/flush', this.session)).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${this.id}": flush after idle injection failed: ${String(error)}`)
        })
      }
    }
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
