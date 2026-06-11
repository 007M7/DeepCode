import { Context, Service } from 'cordis'
import type { ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionEventType } from './types.ts'

export * from './types.ts'

declare module 'cordis' {
  interface Context {
    sessions: SessionStore
  }

  interface Events {
    /** A session was created in the store. */
    'session/created'(session: Session): void
    /** An event was appended to a session log (sync, fire-and-forget). */
    'session/event'(session: Session, event: SessionEvent): void
    /**
     * Awaited durability checkpoint. The agent loop awaits
     * `ctx.parallel('session/flush', session)` at every turn end; persistence
     * plugins (JSONL, sqlite — TODO, future phase) drain their write-behind
     * buffers here and on fiber dispose.
     */
    'session/flush'(session: Session): Promise<void> | void
  }
}

/**
 * Renders a `context/message` or `steering/message` event as a tagged
 * synthetic user-role message (the system-reminder pattern: zero adapter
 * burden, models distinguish it from real user prompts by the envelope).
 *
 * TODO(review): revisit the envelope once a real adapter exists.
 */
function renderTagged(tag: string, content: ContentBlock[], source: MessageSource): ContentBlock[] {
  const open = `<${tag} source=${JSON.stringify(source.kind)}>`
  const close = `</${tag}>`
  return [
    { type: 'text', text: open },
    ...content,
    { type: 'text', text: close },
  ]
}

/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create instances via `ctx.sessions.create()`.
 * Seeding with an existing event log replays/forks a session.
 */
export class Session {
  private log: SessionEvent[] = []
  /** Set by the store so appends are observable; no-op when detached. */
  onAppend?: (event: SessionEvent) => void

  constructor(public readonly id: string, seed?: SessionEvent[]) {
    if (seed) this.log = [...seed]
  }

  get events(): readonly SessionEvent[] {
    return this.log
  }

  get seq(): number {
    return this.log.length
  }

  /** Append one event. Synchronous — the hot path never blocks on I/O. */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
    const event = { type, seq: this.log.length, time: Date.now(), data } as SessionEvent<T>
    this.log.push(event)
    this.onAppend?.(event)
    return event
  }

  /**
   * Derive the LLM message history from the event log.
   *
   * - `user/message` → user message
   * - `assistant/message` → assistant message (chunks are skipped — they are
   *   replay/UI data; the assembled message is authoritative for history)
   * - `tool/result` → user message carrying a tool-result block
   * - `context/message` / `steering/message` → tagged synthetic user messages
   *   at their chronological position
   */
  deriveMessages(): Message[] {
    const messages: Message[] = []
    for (const event of this.log) {
      switch (event.type) {
        case 'user/message': {
          messages.push({ role: 'user', content: event.data.content })
          break
        }
        case 'assistant/message': {
          messages.push({ role: 'assistant', content: event.data.content })
          break
        }
        case 'tool/result': {
          const { callId, content, isError } = event.data
          messages.push({
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
          })
          break
        }
        case 'context/message': {
          const { content, source } = event.data
          messages.push({ role: 'user', content: renderTagged('context', content, source) })
          break
        }
        case 'steering/message': {
          const { content, source } = event.data
          messages.push({ role: 'user', content: renderTagged('steering', content, source) })
          break
        }
      }
    }
    return messages
  }
}

/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
export class SessionStore extends Service {
  private store = new Map<string, Session>()
  private counter = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  /** Create a session. `seed` replays/forks an existing event log. */
  create(id?: string, seed?: SessionEvent[]): Session {
    id ??= `session-${++this.counter}`
    if (this.store.has(id)) throw new Error(`session "${id}" already exists`)
    const session = new Session(id, seed)
    this.ctx.effect(() => {
      session.onAppend = (event) => this.ctx.emit('session/event', session, event)
      this.store.set(id, session)
      this.ctx.emit('session/created', session)
      return () => {
        session.onAppend = undefined
        this.store.delete(id)
      }
    }, 'sessions.create()')
    return session
  }

  get(id: string): Session | undefined {
    return this.store.get(id)
  }

  list(): Session[] {
    return [...this.store.values()]
  }
}

export default SessionStore
