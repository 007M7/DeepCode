/**
 * Browser-local object layer over one Session's durable message-feedback
 * sidecar. The Host owns per-item compare-and-set: every mutation carries the
 * version this controller last observed, and a `version-conflict` reply carries
 * the authoritative item, so a lost race reconciles from the reply itself
 * instead of refetching the whole Session.
 * @module @deepseek-ai/dsh-client-ui-feedback/client/controller
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageId, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  MessageFeedbackDeleteResult,
  MessageFeedbackItem,
  MessageFeedbackListResult,
  MessageFeedbackPutResult,
  MessageFeedbackRating,
} from '@deepseek-ai/dsh-message-feedback/types'

/** The three Remote calls this controller needs, named without the transport. */
export interface MessageFeedbackRemote {
  list: (request: { sessionId: SessionId }) => Promise<MessageFeedbackListResult>
  put: (request: {
    sessionId: SessionId
    messageId: MessageId
    rating: MessageFeedbackRating
    note?: string
    ifVersion: MessageFeedbackItem['version'] | null
  }) => Promise<MessageFeedbackPutResult>
  delete: (request: {
    sessionId: SessionId
    messageId: MessageId
    ifVersion: MessageFeedbackItem['version']
  }) => Promise<MessageFeedbackDeleteResult>
}

/** Load state of the one list read that seeds every per-message control. */
export type FeedbackStatus = 'cold' | 'loading' | 'ready' | 'error'

/** Immutable view published to every per-message control in one Session. */
export interface FeedbackView {
  status: FeedbackStatus
  /** Current item per message, keyed by the addressed message id. */
  items: ReadonlyMap<MessageId, MessageFeedbackItem>
  /** Reason the last load failed, cleared by the next successful load. */
  error: string | null
}

/** Settled action shape rendered by the message-level controls. */
export type FeedbackActionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }

const EMPTY_ITEMS: ReadonlyMap<MessageId, MessageFeedbackItem> = Object.freeze(new Map())

const INITIAL_VIEW: FeedbackView = Object.freeze({
  status: 'cold',
  items: EMPTY_ITEMS,
  error: null,
})

const OK: FeedbackActionResult = Object.freeze({ ok: true })

/** Human-readable text for one business failure code. */
function describe(code: string): string {
  switch (code) {
    case 'session-not-found': return 'this session is no longer persisted'
    case 'target-not-found': return 'this message is not a persisted assistant message'
    case 'version-conflict': return 'feedback changed elsewhere'
    case 'note-blank': return 'a note must contain a non-whitespace character'
    case 'note-too-large': return 'the note is too long'
    default: return code
  }
}

/** Build the rejected branch for one business failure code. */
function fail(code: string): FeedbackActionResult {
  return { ok: false, error: { code, message: describe(code) } }
}

/**
 * Per-session feedback object layer. One instance backs every per-message
 * control in that Session, so a single list read seeds them all.
 */
export class FeedbackController implements HostObservable<FeedbackView> {
  private view = INITIAL_VIEW
  private readonly listeners = new Set<() => void>()
  private loadPromise: Promise<FeedbackActionResult> | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private disposed = false

  /**
   * @param remote - the messageFeedback Remote namespace.
   * @param sessionId - Session owning every addressed assistant message.
   */
  constructor(
    private readonly remote: MessageFeedbackRemote,
    private readonly sessionId: SessionId,
  ) {}

  /** Return the cached immutable view. */
  getSnapshot = (): FeedbackView => this.view

  /** Subscribe to view replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Load once; a failed load stays retryable.
   * @returns the settled load result, shared by concurrent callers.
   */
  ensure(): Promise<FeedbackActionResult> {
    if (this.view.status === 'ready') return Promise.resolve(OK)
    return this.refresh()
  }

  /**
   * Re-read the authoritative list, collapsing concurrent callers onto one
   * in-flight read.
   * @returns the settled reload result.
   */
  refresh(): Promise<FeedbackActionResult> {
    if (this.loadPromise !== null) return this.loadPromise
    this.publish({ status: 'loading', items: this.view.items, error: null })
    const pending = this.load()
    this.loadPromise = pending
    return pending.finally(() => { this.loadPromise = null })
  }

  /**
   * Create or replace feedback for one message, comparing against the version
   * this controller last observed.
   * @param messageId - target assistant message.
   * @param rating - desired judgment.
   * @param note - optional explanation; omitted leaves the note unset.
   * @returns the settled mutation result.
   */
  rate(
    messageId: MessageId,
    rating: MessageFeedbackRating,
    note?: string,
  ): Promise<FeedbackActionResult> {
    return this.mutate(async () => {
      const observed = this.view.items.get(messageId)
      const result = await this.remote.put({
        sessionId: this.sessionId,
        messageId,
        rating,
        ...(note === undefined ? {} : { note }),
        ifVersion: observed?.version ?? null,
      })
      if (result.ok) {
        this.commit(messageId, result.value)
        return OK
      }
      if (result.error.code === 'version-conflict') {
        this.commit(messageId, result.error.current)
      }
      return fail(result.error.code)
    })
  }

  /**
   * Remove feedback for one message. A message with no known item is already
   * in the requested state, so no call is made.
   * @param messageId - target assistant message.
   * @returns the settled mutation result.
   */
  clear(messageId: MessageId): Promise<FeedbackActionResult> {
    return this.mutate(async () => {
      const observed = this.view.items.get(messageId)
      if (observed === undefined) return OK
      const result = await this.remote.delete({
        sessionId: this.sessionId,
        messageId,
        ifVersion: observed.version,
      })
      if (result.ok) {
        this.commit(messageId, null)
        return OK
      }
      if (result.error.code === 'version-conflict') {
        this.commit(messageId, result.error.current)
      }
      return fail(result.error.code)
    })
  }

  /** Drop subscribers and refuse further work when the owning fiber unloads. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  /** Fetch the whole sidecar and publish it as the seeded view. */
  private async load(): Promise<FeedbackActionResult> {
    try {
      const result = await this.remote.list({ sessionId: this.sessionId })
      if (this.disposed) return OK
      if (!result.ok) {
        this.publish({ status: 'error', items: this.view.items, error: describe(result.error.code) })
        return fail(result.error.code)
      }
      const items = new Map<MessageId, MessageFeedbackItem>()
      for (const item of result.value.items) items.set(item.messageId, item)
      this.publish({ status: 'ready', items: Object.freeze(items), error: null })
      return OK
    } catch (error) {
      if (this.disposed) return OK
      const message = error instanceof Error ? error.message : 'message feedback list failed'
      this.publish({ status: 'error', items: this.view.items, error: message })
      return { ok: false, error: { code: 'transport', message } }
    }
  }

  /**
   * Serialize one mutation behind this Session's prior mutation so queued
   * operations always compare against the committed version, and translate a
   * transport throw into the same settled shape the controls already render.
   */
  private mutate(operation: () => Promise<FeedbackActionResult>): Promise<FeedbackActionResult> {
    const guarded = async (): Promise<FeedbackActionResult> => {
      if (this.disposed) return { ok: false, error: { code: 'disposed', message: 'feedback controller is disposed' } }
      const loaded = await this.ensure()
      if (!loaded.ok) return loaded
      try {
        return await operation()
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'transport',
            message: error instanceof Error ? error.message : 'message feedback mutation failed',
          },
        }
      }
    }
    const result = this.operationTail.then(guarded, guarded)
    // `guarded` settles every carrier and business failure as a
    // FeedbackActionResult and never rethrows, so this tail cannot reject and
    // needs no rejection handler.
    this.operationTail = result.then(() => undefined)
    return result
  }

  /**
   * Replace one message's entry, keeping every other entry's identity. Only a
   * `mutate` operation reaches this, and `mutate` refuses admission once the
   * controller is disposed, so no disposal guard belongs here; `publish` is
   * the single place that stops notifying after listeners are dropped.
   */
  private commit(messageId: MessageId, item: MessageFeedbackItem | null): void {
    const items = new Map(this.view.items)
    if (item === null) items.delete(messageId)
    else items.set(messageId, item)
    this.publish({ status: 'ready', items: Object.freeze(items), error: null })
  }

  /** Replace the view and contain subscriber failures at the observable boundary. */
  private publish(view: FeedbackView): void {
    this.view = Object.freeze(view)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[ui-feedback] subscriber threw:', error)
      }
    }
  }
}
