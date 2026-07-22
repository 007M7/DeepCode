// @vitest-environment jsdom
/**
 * M1a regression pin: the per-scope selection must survive list refreshes.
 * Drives the REAL SessionsService + ConversationService chain over the
 * programmable wire fake — a late list refresh that upgrades the display
 * title (bare id → cwd basename) and a reconnect-driven refreshList+resync
 * must neither recreate the session scope nor clear the selection account.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'

// The runtime package's programmable fake lives in its tests; import through
// the src path (same pattern the runtime specs use — test-support material).
import { FakeApiClient, ok } from '../../runtime/tests/fake-api.ts'

const sid = (s: string): SessionId => s as SessionId

interface Bench {
  ctx: Context
  api: FakeApiClient
  sessions: SessionsService
  conversation: ConversationService
}

function bench(): Bench {
  const ctx = new Context()
  const api = new FakeApiClient()
  const sessions = new SessionsService(ctx, api)
  const conversation = new ConversationService(ctx)
  return { ctx, api, sessions, conversation }
}

async function flush(): Promise<void> {
  // Manager notifier + store batching are microtask-based.
  await Promise.resolve()
  await Promise.resolve()
}

function feed(b: Bench, rows: { id: string; cwd?: string; running?: boolean }[]): void {
  b.api.onList = () => Promise.resolve(ok({
    items: rows.map(r => ({
      sessionId: sid(r.id), updatedAt: 1, running: r.running ?? false,
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
    })),
  }) as never)
}

describe('selection survives list refreshes (M1a)', () => {
  it('create → select → title-upgrading refresh keeps scope, binding, store and value', async () => {
    const b = bench()
    // First-send shape: client-side create inserts the row without cwd (title = bare id).
    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s1') }))
    const id = await b.sessions.create({})
    await flush()
    expect(b.sessions.list.getSnapshot().byId[id]?.title).toBe('s1')

    const binding = b.sessions.binding(id)
    expect(binding).toBeDefined()
    const scoped = b.sessions.scope(id)!
    const store = (scoped.get('conversation') as ConversationService).selection
    store.set({ turnSeq: 3, callId: 'c1' })

    // The late list refresh lands (host knows the cwd → formal title).
    feed(b, [{ id: 's1', cwd: '/w/proj-a' }])
    await b.sessions.manager.refreshList()
    await flush()
    expect(b.sessions.list.getSnapshot().byId[id]?.title).toBe('proj-a')

    // Scope, binding and the selection account must all be identity-stable.
    expect(b.sessions.scope(id)).toBe(scoped)
    expect(b.sessions.binding(id)).toBe(binding)
    const after = (b.sessions.scope(id)!.get('conversation') as ConversationService).selection
    expect(after).toBe(store)
    expect(after.getSnapshot()).toEqual({ turnSeq: 3, callId: 'c1' })
  })

  it('reconnect (handleConnected: refreshList + resync) keeps the selection account', async () => {
    const b = bench()
    feed(b, [{ id: 's1' }])
    await b.sessions.manager.refreshList()
    await flush()

    const scoped = b.sessions.scope(sid('s1'))!
    const store = (scoped.get('conversation') as ConversationService).selection
    store.set({ turnSeq: 1, callId: 'c9' })

    // Reconnect generation: title upgrade arrives with the re-pull.
    feed(b, [{ id: 's1', cwd: '/w/proj-a', running: true }])
    b.sessions.manager.handleConnected()
    await flush()
    await flush()

    expect(b.sessions.scope(sid('s1'))).toBe(scoped)
    const after = (b.sessions.scope(sid('s1'))!.get('conversation') as ConversationService).selection
    expect(after).toBe(store)
    expect(after.getSnapshot()).toEqual({ turnSeq: 1, callId: 'c9' })
  })

  it('a transiently failing list refresh does not prune live scopes', async () => {
    const b = bench()
    feed(b, [{ id: 's1' }])
    await b.sessions.manager.refreshList()
    await flush()
    const scoped = b.sessions.scope(sid('s1'))!
    const store = (scoped.get('conversation') as ConversationService).selection
    store.set({ turnSeq: 2, callId: 'c2' })

    // Wire hiccup: the reconnect-time list RPC throws (transport error).
    b.api.onList = () => Promise.reject(new Error('boom'))
    b.sessions.manager.handleConnected()
    await flush()
    await flush()

    expect(b.sessions.scope(sid('s1'))).toBe(scoped)
    expect((b.sessions.scope(sid('s1'))!.get('conversation') as ConversationService).selection.getSnapshot())
      .toEqual({ turnSeq: 2, callId: 'c2' })
  })
})
