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
  ChatViewInjected, ComposerBarInjected, ConversationInjected, ConversationSessionInjected, DetailsInjected,
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
      // Reflect.get is typed any; the probe only records property names.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return Reflect.get(target, prop, receiver)
    },
  })
  void scopeOf(spy)
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
    byId: { [ROOT]: { id: ROOT, title: 'R', displayTitle: 'R', cwd: '/proj', running: false, blank: false, updatedAt: 1 } },
    current: ROOT,
    phase: 'ready',
  })
  const sessionFake = {
    sessionId: ROOT,
    open: vi.fn(() => Promise.resolve()),
    loadOlder: vi.fn(() => Promise.resolve()),
    prompt: vi.fn<() => Promise<{ ok: boolean; value?: object; error?: { code: string; message: string } }>>(
      () => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<() => Promise<{ ok: boolean; value?: object; error?: { code: string; message: string } }>>(
      () => Promise.resolve({ ok: true, value: { accepted: true } })),
    // Observable face (the input machine's queue read face rides it).
    getSnapshot: () => ({ queue: [] }),
    subscribe: () => () => {},
  }
  const scopes = new Map<SessionId, Context>()
  const mint = (id: SessionId): Context => {
    let scoped = scopes.get(id)
    if (scoped === undefined) {
      scoped = ctx.plugin(() => {}).ctx.extend({ [SCOPE_TAG]: id })
      scopes.set(id, scoped)
    }
    return scoped
  }
  type TestProvider = {
    resolve(binding: { sessionId: SessionId; session: typeof sessionFake; ctx: Context }): {
      hooks?: Record<string, unknown>
      props?: Record<string, unknown>
    }
  }
  const providers: TestProvider[] = []
  const absentInfo = { sessionId: undefined, hooks: {}, props: {} }
  const sessionsFake = {
    list: listStore,
    binding: (id: SessionId) => ({ sessionId: id, session: sessionFake, ctx: mint(id) }),
    scope: (id: SessionId) => mint(id),
    provideInfo: () => undefined,
    currentProvideInfo: { getSnapshot: () => absentInfo, subscribe: () => () => {} },
    provide: (descriptor: TestProvider) => { providers.push(descriptor); return () => {} },
    scopeOf,
    sessionOf: (actx: Context) => (scopeOf(actx) === undefined ? undefined : sessionFake),
    open: vi.fn(),
  }
  ctx.provide('sessions', sessionsFake)
  const workspaceStore = createSnapshotStore<WorkspaceListState>({
    items: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  const workspacesFake = {
    list: workspaceStore,
    connectWorkspace: vi.fn(async () => ROOT),
    openPath: vi.fn(async () => {}),
  }
  ctx.provide('workspaces', workspacesFake)
  const layoutFake = { openDetails: vi.fn(), closeDetails: vi.fn() }
  ctx.provide('layout', layoutFake)
  ctx.provide('locale', { bind: () => (key: string) => key })

  // The AppFrame role: the three conversation-package slots must be declared
  // by a live entry before apply can contribute into them (the stand-in
  // consumes renderSlot to satisfy the declare-means-render check).
  slots.register({
    name: 'root',
    children: {
      'conversation': { kind: 'single', scope: 'session-maybe' },
      'details': { kind: 'single', scope: 'session' },
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
  const entryOf = (key: 'conversation' | 'conversation.session' | 'conversation.composer.bar' | 'conversation.view' | 'details') => hostFace.entriesOf(key)[0]!
  /** Resolve store instance + call the inject the way the outlet would. */
  const conversationSurface = (id: SessionId) => {
    const entry = entryOf('conversation.session')
    const instance = hostFace.storeOf(entry, id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationSessionInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  const residentSurface = (id: SessionId | undefined) => {
    const entry = entryOf('conversation')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ConversationInjected)(id)
  }
  const composerSurface = (id: SessionId | undefined) => {
    const entry = entryOf('conversation.composer.bar')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ComposerBarInjected)(id)
  }
  /** Same resolution for the chat entry riding the view ring. */
  const chatViewSurface = (id: SessionId) => {
    const entry = entryOf('conversation.view')
    const instance = hostFace.storeOf(entry, id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ChatViewInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  /** Materialize the input provide contribution the way the runtime does. */
  const inputSurface = (id: SessionId) => {
    const contribution = providers[0]!.resolve(sessionsFake.binding(id))
    const state = contribution.hooks!['input'] as {
      getSnapshot: () => { draft: string }
      subscribe: (fn: () => void) => () => void
    }
    const actions = contribution.props!['inputActions'] as {
      setDraft: (text: string) => void
      submit: (mode?: 'queue' | 'steer') => void
    }
    return { state, actions }
  }
  return {
    ctx, slots, hostFace, entryOf, conversationSurface, residentSurface, composerSurface, chatViewSurface, inputSurface,
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

  it('the provide-channel input face submits through the machine sink: trim, optimistic clear, failure restore without clobber', async () => {
    const b = await bench()
    const { injected } = b.conversationSurface(ROOT)
    const { state, actions } = b.inputSurface(ROOT)
    // Whitespace-only: the machine treats it as empty — no prompt, draft kept.
    actions.setDraft('   ')
    actions.submit('queue')
    expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    expect(state.getSnapshot().draft).toBe('   ')
    // Success: cleared and stays cleared.
    actions.setDraft('hello')
    actions.submit('queue')
    expect(state.getSnapshot().draft).toBe('')
    await Promise.resolve()
    expect(b.sessionFake.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    // Failure: restored (draft still empty when the rejection lands).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b' } })
    actions.setDraft('retry me')
    actions.submit('queue')
    await vi.waitFor(() => {
      expect(state.getSnapshot().draft).toBe('retry me')
    })
    // Failure landing after new typing: no clobber (restore fills empty only).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b' } })
    actions.submit('queue')
    actions.setDraft('typed during flight')
    await new Promise(r => setTimeout(r, 0))
    expect(state.getSnapshot().draft).toBe('typed during flight')
    // The provide contribution is idempotent per session: one shell identity.
    expect(b.inputSurface(ROOT).state).toBe(state)
    // The draft mirror rides the conversation inject face.
    const mirrored: string[] = []
    const unbind = injected.bindDraftMirror(text => mirrored.push(text))
    actions.setDraft('mirrored text')
    expect(mirrored).toEqual(['mirrored text'])
    unbind()
    // Stop failure is swallowed (promptError owns the surface).
    b.sessionFake.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x' } })
    b.composerSurface(ROOT).stop()
    await new Promise(r => setTimeout(r, 0))
    expect(b.sessionFake.cancel).toHaveBeenCalledTimes(1)
  })

  it('inject fails loud when the session resolves no scope or the scope lacks the service', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation.composer.bar')
    const injectFn = entry.inject as unknown as (sessionId: SessionId) => ComposerBarInjected
    // Unknown session: sessions.scope answers nothing.
    ;(b.sessionsFake.scope as unknown) = () => undefined
    expect(() => { injectFn(ROOT).stop() }).toThrow(/resolved no scope/)
    // A scope minted outside the service tree: no conversation service on it.
    const foreign = new Context()
    ;(b.sessionsFake.scope as unknown) = () => foreign.plugin(() => {}).ctx.extend({})
    expect(() => { injectFn(ROOT).stop() }).toThrow(/unavailable through the session scope/)
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

  it('openFile (chat view face) resolves against session cwd and calls workspaces.openPath', async () => {
    const b = await bench()
    const { injected } = b.chatViewSurface(ROOT)
    injected.openFile('src/a.ts')
    await vi.waitFor(() => {
      expect(b.workspacesFake.openPath).toHaveBeenCalledWith('/proj/src/a.ts')
    })
  })

  it('routes navigation and workspace switching through the runtime owners, carrying the draft', async () => {
    const b = await bench()
    const { injected } = b.conversationSurface(ROOT)
    const resident = b.residentSurface(ROOT)
    injected.open(ROOT)
    expect(b.sessionsFake.open).toHaveBeenCalledWith(ROOT)
    // Same-session connect (the picked workspace resolves to this session):
    // no draft movement, plain re-open.
    const { state, actions } = b.inputSurface(ROOT)
    actions.setDraft('carry me')
    void resident.selectWorkspace('workspace-1' as never)
    await vi.waitFor(() => { expect(b.sessionsFake.open).toHaveBeenCalledTimes(2) })
    expect(b.workspacesFake.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(state.getSnapshot().draft).toBe('carry me')
    // Cross-session connect: the draft MOVES — the old machine empties, the
    // new session's machine receives the text, then navigation lands there.
    const OTHER = 'other-1' as SessionId
    b.workspacesFake.connectWorkspace.mockResolvedValueOnce(OTHER)
    void resident.selectWorkspace('workspace-2' as never)
    await vi.waitFor(() => { expect(b.sessionsFake.open).toHaveBeenCalledWith(OTHER) })
    expect(state.getSnapshot().draft).toBe('')
    expect(b.inputSurface(OTHER).state.getSnapshot().draft).toBe('carry me')
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
    const conv = b.hostFace.storeOf(b.entryOf('conversation.session'), ROOT)
    const details = b.hostFace.storeOf(entry, ROOT)
    expect(details).toBe(conv)
  })

})
