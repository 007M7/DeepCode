/**
 * ConversationService implementation: scope-addressed send/cancel and the
 * empty-state startSession chain. Contract: api-contracts v3 section 7.
 * Selection/draft state moved to the declared chat store (slot terminal
 * design §4); the view registry moved to the 'conversation.view' slot (slot
 * ledger owns registration, ordering, and disposal) — what remains is the
 * send/stop orchestration face.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with scopeOf (same mechanism as the host tool
 * registry). Mutable state lives in plain objects reached by one property
 * read — field assignment through the tracker's shadow proxy is off-limits,
 * as are `#` hard-private fields.
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

  /**
   * Empty-state first-send chain (root-context method; does not read scope):
   * create the session, navigate to it, then send through the new scope.
   * The create → open ordering is safe: the manager merges the new summary
   * synchronously before create() resolves, so the list store is projected by
   * the time open() validates against it (manager notification batching is
   * microtask-based; SessionsService projects on the same flush that create
   * awaited through the RPC round trip).
   * @param opts - project directory, prompt text, and send mode.
   */
  async startSession(opts: { cwd?: string; text: string; mode: 'queue' | 'steer' }): Promise<void> {
    const sessions = this.requireSessions()
    const id = await sessions.create(opts.cwd === undefined ? {} : { cwd: opts.cwd })
    // The manager notifier flushes per microtask; one await guarantees the
    // list-store projection landed before sessions.open validates against it.
    await Promise.resolve()
    sessions.open(id)
    const scoped = sessions.scope(id)
    if (scoped === undefined) throw new Error(`conversation.startSession: created session "${id}" resolved no scope`)
    // ctx.get, not scoped.conversation: property access walks the fiber
    // topology (a scope fiber never injects services), while get reads the
    // global store and still binds this service to the scoped ctx.
    const scopedConversation = scoped.get('conversation')
    if (scopedConversation === undefined) throw new Error('conversation.startSession: conversation service unavailable through the new scope')
    await scopedConversation.send(opts.text, opts.mode)
  }

  /** Resolve the caller scope's Session or throw on root contexts. */
  private scopedSession(op: string): Session {
    const id = this.scopeId(op)
    return this.requireSessions().manager.get(id)
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
