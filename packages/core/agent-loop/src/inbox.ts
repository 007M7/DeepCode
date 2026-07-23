/**
 * Per-agent message inbox: queued and steering FIFOs. Purely an in-memory
 * mechanism of the loop driver — the public surface is `Agent.send()` and its
 * fixed-preset aliases.
 *
 * @module dsh-agent-loop/inbox
 */

import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { AgentMessage, AgentMessageId, HookContext } from '@deepseek-ai/dsh-agent'

/** One message waiting in an agent's inbox; `id` is the value `send` returned. */
export interface InboxMessage {
  id: AgentMessageId
  content: ContentBlock[]
  source: MessageSource
  contexts: HookContext[]
  /** Whether the item is marked to wake the driver or force a continuation. */
  wakeup: boolean
}

/**
 * Build the `agent/inbox/*` event payload for one inbox item.
 * @param message - the accepted inbox record.
 * @param steering - whether the item is in the steering FIFO (`next-step`).
 * @returns the live-event message for enqueue/dequeue/discard.
 */
export function agentMessage(message: InboxMessage, steering: boolean): AgentMessage {
  return { id: message.id, content: message.content, source: message.source, contexts: message.contexts, steering, wakeup: message.wakeup }
}

/**
 * Per-agent inbox: a queued FIFO (dequeued once per turn start) and a steering FIFO
 * (drained between steps of a running turn). Purely an in-memory mechanism of
 * the loop — the public surface is `Agent.send()` and its aliases.
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
   * Add a message to the queued FIFO, waking a parked {@link waitForQueued}
   * unless the item opted out. A non-waking item still runs once any woken
   * item or later wakeup drives the parked loop.
   * @param message - the message to queue for the next turn start.
   * @param wake - whether to wake a parked idle wait (default true).
   */
  enqueue(message: InboxMessage, wake = true): void {
    this.queuedMessages.push(message)
    if (wake) this.wakeup?.()
  }

  /**
   * Add a message to the steering FIFO. Deliberately no wakeup: steering is
   * drained between steps of a running turn, never by the idle wait —
   * `Agent.steer()` on an idle agent falls back to a woken follow-up instead.
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
   * Snapshot the pending items (queued then steering, FIFO order) without
   * removing them — the discard notification's payload source.
   * @returns the pending items paired with whether each is steering.
   */
  pending(): { message: InboxMessage; steering: boolean }[] {
    return [
      ...this.queuedMessages.map(message => ({ message, steering: false })),
      ...this.steeringMessages.map(message => ({ message, steering: true })),
    ]
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
