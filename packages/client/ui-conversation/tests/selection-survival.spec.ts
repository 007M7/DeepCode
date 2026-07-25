// @vitest-environment jsdom
/**
 * Selection survival across the store seat (terminal design §4): the chat
 * store now carries what the per-scope selection account used to — this pins
 * the same behavior contract in the new mechanism. Drives the REAL
 * SlotsService store axis with the shared createChatStore handle (the exact
 * apply.ts shape: one handle, two session-slot registrations): same session's
 * two slots resolve one instance (conversation writes, details reads);
 * sessions are isolated; a session's death buries its instance AND its
 * persisted draft; a list refresh does not touch instance identity.
 */
import { Context } from 'cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { SessionsService, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createChatStore } from '../src/client/stores.ts'

// The runtime package's programmable fake lives in its tests; import through
// the src path (same pattern the runtime specs use — test-support material).
import { FakeApiClient, ok } from '../../runtime/tests/fake-api.ts'

const sid = (s: string): SessionId => s as SessionId

interface Bench {
  ctx: Context
  api: FakeApiClient
  sessions: SessionsService
  slots: SlotsService
  chat: ReturnType<typeof createChatStore>
}

function bench(): Bench {
  const ctx = new Context()
  const api = new FakeApiClient()
  const sessions = new SessionsService(ctx, api)
  // Service self-registers as ctx 'slots' (cordis Service constructor).
  const slots = new SlotsService(ctx)
  const chat = createChatStore()
  // The apply.ts shape: one shared handle across both session-slot
  // registrations. 'conversation'/'details' must first exist in the ledger —
  // register a root occupant declaring them (the AppFrame role; the stand-in
  // consumes renderSlot to satisfy the declare-means-render check).
  slots.register({
    name: 'root',
    children: {
      'conversation': { kind: 'single', scope: 'session' },
      'details': { kind: 'single', scope: 'session' },
    },
  }, (_p: { renderSlot?: unknown }) => null)
  slots.register({ name: 'conversation', store: chat }, () => null)
  slots.register({ name: 'details', store: chat }, () => null)
  return { ctx, api, sessions, slots, chat }
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

/** Resolve the store instance the renderer would hand a slot's component for a session. */
function storeFor(b: Bench, slot: 'conversation' | 'details', sessionId: SessionId) {
  const host = renderHost(b)
  const entry = host.entriesOf(slot)[0]!
  return host.storeOf(entry, sessionId)! as ReturnType<ReturnType<typeof createChatStore>['create']>
}

/** The host face is only built at renderSlot time; install a stub renderer once to reach it. */
function renderHost(b: Bench): import('@deepseek-ai/dsh-client-ui-slots').SlotRendererHost {
  const captured = (b as unknown as { _host?: import('@deepseek-ai/dsh-client-ui-slots').SlotRendererHost })
  if (captured._host === undefined) {
    b.slots.install({
      renderRoot: (host) => {
        captured._host = host
        return null
      },
    })
    b.slots.renderSlot('root', {})
  }
  return captured._host!
}

beforeEach(() => {
  localStorage.clear()
})

describe('selection survives on the store seat', () => {
  it('one session, two slots: conversation writes, details reads the SAME instance', async () => {
    const b = bench()
    feed(b, [{ id: 's1' }])
    await b.sessions.manager.refreshList()
    await flush()

    const conv = storeFor(b, 'conversation', sid('s1'))
    const details = storeFor(b, 'details', sid('s1'))
    conv.actions.select({ turnSeq: 3, callId: 'c1' })
    expect(details.store.getSnapshot().selection).toEqual({ turnSeq: 3, callId: 'c1' })
    // Identity, not just value: the shared handle resolves one instance per scope key.
    expect(details).toBe(conv)
  })

  it('sessions are isolated: s2 selection never bleeds into s1', async () => {
    const b = bench()
    feed(b, [{ id: 's1' }, { id: 's2' }])
    await b.sessions.manager.refreshList()
    await flush()

    const one = storeFor(b, 'conversation', sid('s1'))
    const two = storeFor(b, 'conversation', sid('s2'))
    expect(two).not.toBe(one)
    one.actions.select({ turnSeq: 1, callId: 'a' })
    two.actions.select({ turnSeq: 9, callId: 'z' })
    expect(one.store.getSnapshot().selection).toEqual({ turnSeq: 1, callId: 'a' })
    expect(two.store.getSnapshot().selection).toEqual({ turnSeq: 9, callId: 'z' })
  })

  it('a display-title-upgrading list refresh keeps instance identity and the selection value', async () => {
    const b = bench()
    // First-send shape: client-side create inserts the row without cwd (title = bare id).
    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s1') }))
    const id = await b.sessions.create({})
    await flush()
    expect(b.sessions.list.getSnapshot().byId[id]).toMatchObject({ displayTitle: 's1' })
    expect(b.sessions.list.getSnapshot().byId[id]?.title).toBeUndefined()

    const store = storeFor(b, 'conversation', id)
    store.actions.select({ turnSeq: 3, callId: 'c1' })
    store.actions.setDraft('half-typed')

    // The late list refresh lands (host knows the cwd → better fallback label).
    feed(b, [{ id: 's1', cwd: '/w/proj-a' }])
    await b.sessions.manager.refreshList()
    await flush()
    expect(b.sessions.list.getSnapshot().byId[id]).toMatchObject({ displayTitle: 'proj-a' })
    expect(b.sessions.list.getSnapshot().byId[id]?.title).toBeUndefined()

    const after = storeFor(b, 'conversation', id)
    expect(after).toBe(store)
    expect(after.store.getSnapshot().selection).toEqual({ turnSeq: 3, callId: 'c1' })
    expect(after.store.getSnapshot().draft).toBe('half-typed')
  })

  it('session death buries the instance and its persisted draft', async () => {
    const b = bench()
    feed(b, [{ id: 's1' }, { id: 's2' }])
    await b.sessions.manager.refreshList()
    await flush()

    // Mint the scope (store prune rides the scope-teardown axis: no scope,
    // no teardown — the real page always resolves the binding to render).
    b.sessions.binding(sid('s1'))
    const doomed = storeFor(b, 'conversation', sid('s1'))
    doomed.actions.setDraft('to be buried')
    doomed.actions.select({ turnSeq: 1 })
    expect(localStorage.getItem('dsh.conversation.chat.s1')).not.toBeNull()

    // Watch elsewhere so s1's scope teardown is not deferred, then remove it.
    b.sessions.binding(sid('s2'))
    feed(b, [{ id: 's2' }])
    await b.sessions.manager.refreshList()
    await flush()

    // Persisted residue is gone with the session...
    expect(localStorage.getItem('dsh.conversation.chat.s1')).toBeNull()
    // ...and a re-created same-id session starts from a FRESH instance.
    feed(b, [{ id: 's1' }, { id: 's2' }])
    await b.sessions.manager.refreshList()
    await flush()
    const reborn = storeFor(b, 'conversation', sid('s1'))
    expect(reborn).not.toBe(doomed)
    expect(reborn.store.getSnapshot()).toEqual({ selection: null, draft: '', view: null })
  })
})
