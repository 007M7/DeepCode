// @vitest-environment jsdom
/**
 * Exercises selection persistence through the real SlotsService store axis;
 * component stubs cannot prove per-session identity or disposal.
 */
import { Context } from 'cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSnapshotStore, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { createChatStore } from '../src/client/stores.ts'

const sid = (s: string): SessionId => s as SessionId

/** Identity-stable no-session bundle (uSES getSnapshot contract). */
const ABSENT_INFO = { sessionId: undefined, hooks: {}, props: {} }

interface Bench {
  slots: SlotsService
  chat: ReturnType<typeof createChatStore>
}

function bench(): Bench {
  const ctx = new Context()
  ctx.provide('sessions', {
    list: createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'ready',
    }),
    provideInfo: () => undefined,
    currentProvideInfo: {
      getSnapshot: () => ABSENT_INFO,
      subscribe: () => () => {},
    },
    provide: () => () => {},
  })
  ctx.provide('workspaces', {
    list: createSnapshotStore<WorkspaceListState>({
      items: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    }),
  })
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
      'conversation': { kind: 'single', scope: 'session-maybe' },
      'conversation.session': { kind: 'single', scope: 'session' },
      'details': { kind: 'single', scope: 'session' },
    },
  }, (_p: { renderSlot?: unknown }) => null)
  // apply.ts mounts the shared chat handle only under session-scope slots
  // (the session-maybe 'conversation' shell carries no store).
  slots.register({ name: 'conversation.session', store: chat }, () => null)
  slots.register({ name: 'details', store: chat }, () => null)
  return { slots, chat }
}

/** Resolve the store instance the renderer would hand a slot's component for a session. */
function storeFor(b: Bench, slot: 'conversation.session' | 'details', sessionId: SessionId) {
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
  it('one session, two slots: conversation writes, details reads the SAME instance', () => {
    const b = bench()

    const conv = storeFor(b, 'conversation.session', sid('s1'))
    const details = storeFor(b, 'details', sid('s1'))
    conv.actions.select({ turnSeq: 3, callId: 'c1' })
    expect(details.store.getSnapshot().selection).toEqual({ turnSeq: 3, callId: 'c1' })
    // Identity, not just value: the shared handle resolves one instance per scope key.
    expect(details).toBe(conv)
  })

  it('sessions are isolated: s2 selection never bleeds into s1', () => {
    const b = bench()

    const one = storeFor(b, 'conversation.session', sid('s1'))
    const two = storeFor(b, 'conversation.session', sid('s2'))
    expect(two).not.toBe(one)
    one.actions.select({ turnSeq: 1, callId: 'a' })
    two.actions.select({ turnSeq: 9, callId: 'z' })
    expect(one.store.getSnapshot().selection).toEqual({ turnSeq: 1, callId: 'a' })
    expect(two.store.getSnapshot().selection).toEqual({ turnSeq: 9, callId: 'z' })
  })

  it('a list-projection update keeps instance identity and the selection value', () => {
    const b = bench()
    const id = sid('s1')
    const projection = createSnapshotStore({ displayTitle: 's1' })

    const store = storeFor(b, 'conversation.session', id)
    store.actions.select({ turnSeq: 3, callId: 'c1' })
    store.actions.setDraft('half-typed')

    projection.set({ displayTitle: 'proj-a' })
    expect(projection.getSnapshot().displayTitle).toBe('proj-a')

    const after = storeFor(b, 'conversation.session', id)
    expect(after).toBe(store)
    expect(after.store.getSnapshot().selection).toEqual({ turnSeq: 3, callId: 'c1' })
    expect(after.store.getSnapshot().draft).toBe('half-typed')
  })

  it('session death buries the instance and its persisted draft', () => {
    const b = bench()

    const doomed = storeFor(b, 'conversation.session', sid('s1'))
    doomed.actions.setDraft('to be buried')
    doomed.actions.select({ turnSeq: 1 })
    expect(localStorage.getItem('dsh.conversation.chat.s1')).not.toBeNull()

    // SessionsService calls this public slot lifecycle seam when the scope dies.
    b.slots.pruneStoreScope(sid('s1'))

    // Persisted residue is gone with the session...
    expect(localStorage.getItem('dsh.conversation.chat.s1')).toBeNull()
    // ...and a re-created same-id session starts from a FRESH instance.
    const reborn = storeFor(b, 'conversation.session', sid('s1'))
    expect(reborn).not.toBe(doomed)
    expect(reborn.store.getSnapshot()).toEqual({ selection: null, draft: '', view: null })
  })
})
