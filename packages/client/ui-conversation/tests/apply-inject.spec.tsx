// @vitest-environment jsdom
// apply inject factories exercised end to end against the terminal thin
// shape: the conversation surface (views triple, send choreography incl.
// optimistic clear + failure restore THROUGH the declared store actions,
// openDetails = select action + layout orchestration, sessions.open
// navigation), and the closeDetails details surface. Complements
// chat-apply.spec.tsx (registration)
// and selection-survival.spec.ts (store axis). History opening is NOT an
// inject concern anymore — the runtime sessions service opens on watch
// (sessions-service.spec.ts owns that behavior).

import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotsService, scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-web-react'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatViewInjected, ConversationInjected, DetailsInjected, EmptyStateInjected,
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
    byId: { [ROOT]: { id: ROOT, title: 'R', displayTitle: 'R', cwd: '/proj', running: false, updatedAt: 1 } },
    current: ROOT,
    intent: undefined,
    phase: 'ready',
  })
  const sessionFake = {
    open: vi.fn(() => Promise.resolve()),
    loadOlder: vi.fn(() => Promise.resolve()),
    updatePendingPrompt: vi.fn(),
    retryPendingPrompt: vi.fn(),
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
    binding: (id: SessionId) => ({ sessionId: id, session: sessionFake, ctx: mint(id) }),
    scope: (id: SessionId) => mint(id),
    cell: () => undefined,
    scopeOf,
    open: vi.fn(),
    updateIntent: vi.fn(),
  }
  ctx.provide('sessions', sessionsFake)
  const workspaceStore = createSnapshotStore<WorkspaceListState>({
    items: [], intent: undefined, state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  const workspacesFake = {
    list: workspaceStore,
    startSession: vi.fn(),
    sendSession: vi.fn(),
  }
  ctx.provide('workspaces', workspacesFake)
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
  const entryOf = (key: 'conversation' | 'conversation.view' | 'details' | 'conversation.empty') => hostFace.entriesOf(key)[0]!
  /** Resolve store instance + call the inject the way the outlet would. */
  const conversationSurface = (id: SessionId) => {
    const entry = entryOf('conversation')
    const instance = hostFace.storeOf(entry, id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  /** Same resolution for the chat entry riding the view ring. */
  const chatViewSurface = (id: SessionId) => {
    const entry = entryOf('conversation.view')
    const instance = hostFace.storeOf(entry, id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ChatViewInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  const emptySurface = () => {
    const entry = entryOf('conversation.empty')
    return (entry.inject as unknown as () => EmptyStateInjected)()
  }
  return {
    ctx, slots, hostFace, entryOf, conversationSurface, chatViewSurface, emptySurface,
    sessionFake, sessionsFake, workspacesFake, layoutFake, mint,
  }
}

describe('conversation slot inject surface', () => {
  it('assembles the thin surface side-effect-free', async () => {
    const b = await bench()
    const { injected } = b.conversationSurface(ROOT)
    // Assembly has no session side effects: opening the event window belongs
    // to the runtime watch path, not the inject factory.
    expect(b.sessionFake.open).not.toHaveBeenCalled()
    expect(injected.views.list().map(v => v.id)).toEqual(['chat'])

    const chatView = b.chatViewSurface(ROOT)
    chatView.injected.loadOlder()
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

  it('inject fails loud when the session resolves no scope or the scope lacks the service', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation')
    const instance = b.hostFace.storeOf(entry, ROOT) as ChatInstance
    const injectFn = entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationInjected
    // Unknown session: sessions.scope answers nothing.
    ;(b.sessionsFake.scope as unknown) = () => undefined
    expect(() => injectFn(ROOT, instance.actions)).toThrow(/resolved no scope/)
    // A scope minted outside the service tree: no conversation service on it.
    const foreign = new Context()
    ;(b.sessionsFake.scope as unknown) = () => foreign.plugin(() => {}).ctx.extend({})
    expect(() => injectFn(ROOT, instance.actions)).toThrow(/unavailable through the session scope/)
  })

  it('openDetails (chat view face) writes the selection through the store actions and opens the panel', async () => {
    const b = await bench()
    const { instance, injected } = b.chatViewSurface(ROOT)
    injected.openDetails({ turnSeq: 2, callId: 'c1' })
    expect(instance.store.getSnapshot().selection).toEqual({ turnSeq: 2, callId: 'c1' })
    expect(b.layoutFake.openDetails).toHaveBeenCalledTimes(1)
    // The chat view shares the conversation entry's store instance: selection
    // writes land where the skeleton and details read.
    const conv = b.conversationSurface(ROOT)
    expect(conv.instance).toBe(instance)
  })

  it('routes navigation through SessionsService and the retained prompt through the scoped Session', async () => {
    const b = await bench()
    const { injected } = b.conversationSurface(ROOT)
    injected.open(ROOT)
    injected.updateSessionPrompt('revised')
    injected.retrySessionPrompt()
    expect(b.sessionsFake.open).toHaveBeenCalledWith(ROOT)
    expect(b.sessionFake.updatePendingPrompt).toHaveBeenCalledWith('revised')
    expect(b.sessionFake.retryPendingPrompt).toHaveBeenCalledOnce()
  })

  it('views read face projects the ring ledger (subscribe/version through ctx.slots)', async () => {
    const b = await bench()
    const { injected } = b.conversationSurface(ROOT)
    const before = injected.views.version()
    const listener = vi.fn()
    const unsub = injected.views.subscribe(listener)
    // A second ring rider (what ui-trajectory does in production).
    const off = b.slots.register(
      { name: 'conversation.view', id: 'chat2', order: 5, label: 'X' } as never, (() => null) as never)
    await Promise.resolve() // ledger notifications batch per microtask
    expect(listener).toHaveBeenCalled()
    expect(injected.views.version()).toBeGreaterThan(before)
    expect(injected.views.list().map(v => v.id)).toEqual(['chat', 'chat2'])
    // Label falls back to the id when a rider declares none.
    const off2 = b.slots.register(
      { name: 'conversation.view', id: 'bare', order: 6 } as never, (() => null) as never)
    expect(injected.views.list().map(v => v.label)).toEqual(['Chat', 'X', 'bare'])
    off()
    off2()
    unsub()
  })
})

describe('details inject surface', () => {
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

  it('empty state injects the runtime intent actions and remains storeless', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation.empty')
    expect(entry.store).toBeUndefined()
    const injected = b.emptySurface()
    injected.startSession(undefined, 'fresh')
    injected.startSession('workspace-1' as never, 'retargeted')
    injected.updateSessionPrompt('typed')
    injected.sendSession()
    expect(b.workspacesFake.startSession).toHaveBeenNthCalledWith(1, undefined, 'fresh')
    expect(b.workspacesFake.startSession).toHaveBeenNthCalledWith(2, 'workspace-1', 'retargeted')
    expect(b.sessionsFake.updateIntent).toHaveBeenCalledWith('typed')
    expect(b.workspacesFake.sendSession).toHaveBeenCalledOnce()
  })
})
