/**
 * Scope-addressed conversation send, cancel, history, and retained-prompt orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from 'cordis'
import type { Context } from 'cordis'
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
import type { Session, SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationService extends Service {
  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   */
  constructor(ctx: Context) {
    super(ctx, 'conversation')
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer surface); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block.
   * @param mode - queue after the current turn, or steer into it.
   */
  async send(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const session = this.scopedSession('send')
    const result = await session.prompt([{ type: 'text', text }], mode)
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Cancel the scoped session's in-flight turn (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession('loadOlder').loadOlder()
  }

  /**
   * Update the scoped Session's retained pending prompt.
   * @param text - exact controlled-input value to retain.
   */
  updatePendingPrompt(text: string): void {
    this.scopedSession('updatePendingPrompt').updatePendingPrompt(text)
  }

  /** Retry the scoped Session's retained pending prompt. */
  retryPendingPrompt(): void {
    this.scopedSession('retryPendingPrompt').retryPendingPrompt()
  }

  /** Resolve the caller scope's Session or throw on root contexts. */
  private scopedSession(op: string): Session {
    const id = this.scopeId(op)
    const binding = this.requireSessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.${op}: session "${id}" resolved no binding`)
    return binding.session
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return id
  }

  private requireSessions(): SessionsService {
    // ctx.get instead of ctx.sessions: the typed Context merge is suspended
    // while the client/host `sessions` declaration collision awaits
    // arbitration (see the runtime package's Context merge note).
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }
}
