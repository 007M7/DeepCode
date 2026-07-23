// @vitest-environment jsdom
// apply inject factories exercised end to end against the terminal thin
// shape: the conversation surface (views triple, send choreography incl.
// optimistic clear + failure restore THROUGH the declared store actions,
// openDetails = select action + layout orchestration, watch-driven open,
// sessions.open navigation), the injectless-but-closeDetails details surface,
// and the one-callback empty surface. Complements chat-apply.spec.tsx
// (registration) and selection-survival.spec.ts (store axis).

import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotsService, scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationInjected, DetailsInjected, EmptyStateInjected,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createChatStore } from '../src/client/stores.ts'

afterEach(cleanup)

const ROOT = 'root-1' as SessionId

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>
type ChatActions = ChatInstance['actions']

const SCOPE_TAG: symbol = (() => {
  const recorded: (string | symbol)[] = []
  const spy = new Proxy(new Context(), {
    get(target, prop, receiver) {
      recorded.push(prop)
      return Reflect.get(target, prop, receiver)
    },
  })
  void scopeOf(spy as Context)
  const symbol = recorded.find((p): p is symbol => typeof p === 'symbol')
  if (symbol === undefined) throw new Error('scopeOf probe recorded no symbol read')
  return symbol
})()

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotsService)
  await slotsFiber.await()
  const slots = ctx.get('slots') as SlotsService

  const listStore = createSnapshotStore<SessionListState>({
    ids: [ROOT],
    byId: { [ROOT]: { id: ROOT, title: 'R', cwd: '/proj', running: false, updatedAt: 1 } },
    current: ROOT,
  } as SessionListState)
  const sessionFake = {
    open: vi.fn(() => Promise.resolve()),
    loadOlder: vi.fn(() => Promise.resolve()),
    prompt: vi.fn<() => Promise<{ ok: boolean; value?: object; error?: { code: string; message: string } }>>(
      () => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<() => Promise<{ ok: boolean; value?: object; error?: { code: string; message: string } }>>(
      () => Promise.resolve({ ok: true, value: { accepted: true } })),
  }
  const scopes = new Map<SessionId, Context>()
  const mint = (id: SessionId): Context => {
    let scoped = scopes.get(id)
    if (scoped === undefined) {
      scoped = ctx.plugin(() => {}).ctx.extend({ [SCOPE_TAG]: id }) as Context
      scopes.set(id, scoped)
    }
    return scoped
  }
  const sessionsFake = {
    list: listStore,
    manager: { get: () => sessionFake },
    scope: (id: SessionId) => mint(id),
    cell: () => undefined,
    create: vi.fn(() => Promise.resolve(ROOT)),
    open: vi.fn(),
  }
  ctx.provide('sessions', sessionsFake)
  const layoutFake = { openDetails: vi.fn(), closeDetails: vi.fn() }
  ctx.provide('layout', layoutFake)
  ctx.provide('i18n', { bind: () => (key: string) => key })

  // The AppFrame role: the three conversation-package slots must be declared
  // by a live entry before apply can contribute into them (the stand-in
  // consumes renderSlot to satisfy the declare-means-render check).
  slots.register({
    name: 'root',
    children: {
      'conversation': { kind: 'single', scope: 'session' },
      'details': { kind: 'single', scope: 'session' },
      'conversation.empty': { kind: 'single', scope: 'root' },
    },
  }, (_p: { renderSlot?: unknown }) => null)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()

  // Reach the render-side entry view (inject + store handle) the way the
  // renderer does: through the host face.
  let host: SlotRendererHost | undefined
  slots.install({ renderRoot: (h) => { host = h; return null } })
  slots.renderSlot('root', {})
  const hostFace = host!
  const entryOf = (key: 'conversation' | 'details' | 'conversation.empty') => hostFace.entriesOf(key)[0]!
  /** Resolve store instance + call the inject the way the outlet would. */
  const conversationSurface = (id: SessionId) => {
    const entry = entryOf('conversation')
    const instance = hostFace.storeOf(entry, id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  return { ctx, slots, hostFace, entryOf, conversationSurface, sessionFake, sessionsFake, layoutFake, mint }
}

describe('conversation slot inject surface', () => {
  it('assembles the thin surface, pulls history through the watch signal, navigates via sessions.open', async () => {
    const b = await bench()
    const { injected } = b.conversationSurface(ROOT)
    expect(b.sessionFake.open).toHaveBeenCalledTimes(1)
    expect(injected.views.list().map(v => v.id)).toEqual(['chat'])
    injected.open(ROOT)
    expect(b.sessionsFake.open).toHaveBeenCalledWith(ROOT)
    injected.loadOlder()
    expect(b.sessionFake.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('send trims, optimistically clears through actions, restores on failure without clobbering new typing', async () => {
    const b = await bench()
    const { instance, injected } = b.conversationSurface(ROOT)
    // Whitespace-only: no send, and the (whitespace) draft is not cleared.
    instance.actions.setDraft('   ')
    injected.send('   ', 'queue')
    expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    expect(instance.store.getSnapshot().draft).toBe('   ')
    // Success: cleared and stays cleared.
    instance.actions.setDraft('hello')
    injected.send('hello', 'queue')
    expect(instance.store.getSnapshot().draft).toBe('')
    await Promise.resolve()
    expect(b.sessionFake.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    // Failure: restored (draft still empty when the rejection lands).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b' } })
    instance.actions.setDraft('retry me')
    injected.send('retry me', 'queue')
    await vi.waitFor(() => {
      expect(instance.store.getSnapshot().draft).toBe('retry me')
    })
    // Failure landing after new typing: no clobber (restoreDraft fills empty only).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b' } })
    injected.send('retry me', 'queue')
    instance.actions.setDraft('typed during flight')
    await new Promise(r => setTimeout(r, 0))
    expect(instance.store.getSnapshot().draft).toBe('typed during flight')
    // Stop failure is swallowed (promptError owns the surface).
    b.sessionFake.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x' } })
    injected.stop()
    await new Promise(r => setTimeout(r, 0))
    expect(b.sessionFake.cancel).toHaveBeenCalledTimes(1)
  })

  it('openDetails writes the selection through the store actions and opens the panel', async () => {
    const b = await bench()
    const { instance, injected } = b.conversationSurface(ROOT)
    injected.openDetails({ turnSeq: 2, callId: 'c1' })
    expect(instance.store.getSnapshot().selection).toEqual({ turnSeq: 2, callId: 'c1' })
    expect(b.layoutFake.openDetails).toHaveBeenCalledTimes(1)
  })

  it('views read face forwards to the service registry (subscribe/version)', async () => {
    const b = await bench()
    const { injected } = b.conversationSurface(ROOT)
    const before = injected.views.version()
    const listener = vi.fn()
    const unsub = injected.views.subscribe(listener)
    const conversation = b.ctx.get('conversation') as
      import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationService
    const off = conversation.registerView({ id: 'chat2', label: 'X', component: () => null } as never)
    expect(listener).toHaveBeenCalled()
    expect(injected.views.version()).toBeGreaterThan(before)
    expect(injected.views.list().map(v => v.id)).toEqual(['chat', 'chat2'])
    off()
    unsub()
  })
})

describe('details and empty inject surfaces', () => {
  it('details injects the one layout callback; selection rides the shared store instead', async () => {
    const b = await bench()
    const entry = b.entryOf('details')
    const injected = (entry.inject as unknown as () => DetailsInjected)()
    expect(Object.keys(injected)).toEqual(['closeDetails'])
    injected.closeDetails()
    expect(b.layoutFake.closeDetails).toHaveBeenCalledTimes(1)
    // The shared handle: details resolves the SAME instance conversation writes.
    const conv = b.hostFace.storeOf(b.entryOf('conversation'), ROOT)
    const details = b.hostFace.storeOf(entry, ROOT)
    expect(details).toBe(conv)
  })

  it('empty injects the startSession chain only (no store, cwds derive in-component)', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation.empty')
    expect(entry.store).toBeUndefined()
    const injected = (entry.inject as unknown as () => EmptyStateInjected)()
    expect(Object.keys(injected)).toEqual(['startSession'])
    await injected.startSession({ text: 'go', mode: 'queue' })
    expect(b.sessionsFake.create).toHaveBeenCalled()
    expect(b.sessionsFake.open).toHaveBeenCalledWith(ROOT)
    expect(b.sessionFake.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'go' }], 'queue')
  })
})
