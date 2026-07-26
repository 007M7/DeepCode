/**
 * High-level turns API over {@link HarnessClient}: `DeepSeekHarness` owns one
 * runtime subprocess across many sessions; `HarnessSession.run` sends a
 * prompt and settles with the final response once `session.finished` arrives.
 * Mirrors the Python SDK's `DeepSeekHarness`/`Session` pair.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { HarnessClient } from './client.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessNotification, TurnResult } from './types.ts'

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  /** The underlying JSON-RPC client (exposed for low-level access). */
  readonly client: HarnessClient
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private initialized: Promise<void> | undefined

  /** @param options - runtime launch spec plus the session route (cwd/provider/model). */
  constructor(options: DeepSeekHarnessOptions) {
    this.client = new HarnessClient(options.launch)
    this.cwd = options.cwd ?? options.launch.cwd ?? process.cwd()
    this.provider = options.provider ?? 'deepseek'
    this.model = options.model ?? 'deepseek-v4-flash'
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.client.start()
        await this.client.initialize({ cwd: this.cwd, provider: this.provider, model: this.model })
      } catch (error) {
        this.initialized = undefined
        await this.client.close()
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the settled turn result.
   */
  run(input: string | ContentBlock[], options?: RunOptions): Promise<TurnResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    return this.client.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * One SDK session: a stable id plus the turn loop that pairs a
 * `session/prompt` with its `session.finished`.
 */
export class HarnessSession {
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * Run one prompt turn to settlement.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the settled turn result; rejects on transport loss, timeout, or
   * a protocol error — never on a model-level failure (that is
   * `status: 'error'` in the result).
   */
  async run(input: string | ContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<TurnResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []
    let status: TurnResult['status'] = 'error'
    let reason: TurnEndReason | undefined
    let finished = false

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      notifications.push(notification)
      options?.onNotification?.(notification)
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        events.push(notification.params.event as SessionEvent)
      }
      if (notification.method === 'session.finished' && notification.params.sessionId === this.id) {
        status = notification.params.status === 'ok' ? 'ok' : 'error'
        reason = notification.params.reason as TurnEndReason | undefined
        finished = true
      }
    }
    const accepted = client.prompt(this.id, contentBlocks)
    // Drain concurrently so observers see progress while the prompt request
    // is still pending (its response arrives only after settlement).
    const drain = (async () => {
      while (!finished) collect(await subscription.next())
    })()
    try {
      await Promise.all([accepted, drain])
    } finally {
      // On a prompt rejection the drain is still parked on next(); closing the
      // subscription settles it, and the swallow keeps that secondary
      // TransportClosedError from surfacing as an unhandled rejection.
      subscription.close()
      await drain.catch(() => {})
    }

    return {
      sessionId: this.id,
      status,
      reason,
      finalResponse: finalResponse(events),
      events,
      notifications,
    }
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | ContentBlock[]): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the turn's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
