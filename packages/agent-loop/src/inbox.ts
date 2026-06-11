import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'

/** One message waiting in an agent's inbox. */
export interface InboxMessage {
  content: ContentBlock[]
  source: MessageSource
}

/**
 * Per-agent inbox: a queued FIFO (drained at turn start) and a steering FIFO
 * (drained between steps of a running turn). Purely an in-memory mechanism of
 * the loop — the public surface is `Agent.send()` / `Agent.steer()`.
 */
export class Inbox {
  private queuedMessages: InboxMessage[] = []
  private steeringMessages: InboxMessage[] = []
  private wakeup: (() => void) | undefined

  /** Resolves when a queued message arrives (used by the idle loop). */
  get hasQueued(): boolean {
    return this.queuedMessages.length > 0
  }

  get hasSteering(): boolean {
    return this.steeringMessages.length > 0
  }

  enqueue(message: InboxMessage): void {
    this.queuedMessages.push(message)
    this.wakeup?.()
  }

  steer(message: InboxMessage): void {
    this.steeringMessages.push(message)
  }

  /** Drain all queued messages (turn start). */
  drainQueued(): InboxMessage[] {
    return this.queuedMessages.splice(0)
  }

  /** Drain all steering messages (between steps). */
  drainSteering(): InboxMessage[] {
    return this.steeringMessages.splice(0)
  }

  /** Wait until a queued message arrives or `cancel` resolves. */
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
