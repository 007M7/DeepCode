/**
 * Per-agent message inbox: queued and steering FIFOs. Purely an in-memory
 * mechanism of the loop driver — the public surface is `Agent.send()` and
 * `Agent.steer()`.
 *
 * @module dsh-agent-loop/inbox
 */

import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'

/** One message waiting in an agent's inbox. */
export interface InboxMessage {
  content: ContentBlock[]
  source: MessageSource
}

/**
 * Per-agent inbox: a queued FIFO (dequeued once per turn start) and a steering FIFO
 * (drained between steps of a running turn). Purely an in-memory mechanism of
 * the loop — the public surface is `Agent.send()` / `Agent.steer()`.
 */
export class Inbox {
  private queuedMessages: InboxMessage[] = []
  private steeringMessages: InboxMessage[] = []
  private wakeup: (() => void) | undefined

  /** True while queued messages are pending — read by the idle wait's fast path and the loop's turn-start checks. */
  get hasQueued(): boolean {
    return this.queuedMessages.length > 0
  }

  /** True while steering messages are pending — read by cancellation and the loop's stop-override check. */
  get hasSteering(): boolean {
    return this.steeringMessages.length > 0
  }

  /**
   * Add a message to the queued FIFO and wake a parked {@link waitForQueued}.
   * @param message - the message to queue for the next turn start.
   */
  enqueue(message: InboxMessage): void {
    this.queuedMessages.push(message)
    this.wakeup?.()
  }

  /**
   * Add a message to the steering FIFO. Deliberately no wakeup: steering is
   * drained between steps of a running turn, never by the idle wait —
   * `Agent.steer()` on an idle agent falls back to `send()` instead.
   * @param message - the message to inject between steps of the running turn.
   */
  steer(message: InboxMessage): void {
    this.steeringMessages.push(message)
  }

  /**
   * Remove the oldest queued message for one turn start.
   * @returns the oldest message, or `undefined` when the queued FIFO is empty.
   */
  dequeueQueued(): InboxMessage | undefined {
    return this.queuedMessages.shift()
  }

  /**
   * Drain all steering messages (between steps).
   * @returns the drained messages in arrival order; the steering FIFO is left empty.
   */
  drainSteering(): InboxMessage[] {
    return this.steeringMessages.splice(0)
  }

  /**
   * Discard all pending messages (queued + steering) without delivering them —
   * used by `cancel()`, which drops un-started work rather than draining it into
   * a turn. Unlike `dequeueQueued`/`drainSteering`, the messages are thrown away.
   */
  clear(): void {
    this.queuedMessages.length = 0
    this.steeringMessages.length = 0
  }

  /**
   * Wait until a queued message arrives or `cancel` resolves.
   * @param cancel - a promise whose resolution abandons the wait without a
   *   message (the driver loop passes the agent's disposed promise so a parked
   *   loop can exit).
   */
  waitForQueued(cancel: Promise<void>): Promise<void> {
    if (this.hasQueued) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    this.wakeup = resolve
    void cancel.then(resolve)
    return promise.finally(() => {
      if (this.wakeup === resolve) this.wakeup = undefined
    })
  }
}
