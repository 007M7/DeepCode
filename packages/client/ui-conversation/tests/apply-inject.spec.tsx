// @vitest-environment jsdom
// apply inject factories exercised end to end: the conversation slot surface
// (ancestry feed, views triple, active view, composer choreography incl.
// optimistic clear + failure restore, renderView chrome assembly, watch-driven
// open), the details surface, and the empty-state surface (cwd derivation
// cache). Complements chat-apply.spec.tsx, which stops at registration.

import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { createSnapshotStore, bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { SlotsService, scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationService, ViewEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

afterEach(cleanup)

const ROOT = 'root-1' as SessionId

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

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: ROOT, nodes: [], foldDegraded: false, partial: null, runningCalls: [],
    pending: [], running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, lastAgentError: null,
  } as ConversationSnapshot
}

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotsService)
  await slotsFiber.await()

  const listStore = createSnapshotStore<SessionListState>({
    ids: [ROOT],
    byId: { [ROOT]: { id: ROOT, title: 'R', cwd: '/proj', running: false, updatedAt: 1 } },
  })
  const snap = snapshotBase()
  const sessionFake = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    useSelector: undefined as unknown,
    open: vi.fn(() => Promise.resolve()),
    loadOlder: vi.fn(() => Promise.resolve()),
    prompt: vi.fn<() => Promise<{ ok: boolean; value?: object; error?: { code: string; message: string } }>>(
      () => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<() => Promise<{ ok: boolean; value?: object; error?: { code: string; message: string } }>>(
      () => Promise.resolve({ ok: true, value: { accepted: true } })),
  }
  sessionFake.useSelector = bindSnapshotSelector(sessionFake as never)
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
    ancestry: (id: SessionId) => {
      const s = listStore.getSnapshot().byId[id]
      return s === undefined ? [] : [s]
    },
    scope: (id: SessionId) => mint(id),
    create: vi.fn(() => Promise.resolve(ROOT)),
  }
  ctx.provide('sessions', sessionsFake)
  const layoutFake = {
    current: createSnapshotStore<{ sessionId?: SessionId; viewFor: Record<string, string> }>({ viewFor: {} }),
    open: vi.fn(), openView: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
  }
  ctx.provide('layout', layoutFake)
  ctx.provide('i18n', { bind: () => (key: string) => key })

  const slots = ctx.get('slots') as SlotsService
  slots.define('conversation', { kind: 'single', scope: 'session' })
  slots.define('details', { kind: 'single', scope: 'session' })
  slots.define('conversation.empty', { kind: 'single', scope: 'root' })

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()

  const binding: SessionBinding = {
    sessionId: ROOT as never,
    session: { useSelector: sessionFake.useSelector } as never,
    ctx: mint(ROOT) as never,
  }
  const entryOf = (key: 'conversation' | 'details' | 'conversation.empty') => {
    const entries = slots.entries(key)
    return entries[0]! as { options: { inject: (b: unknown) => Record<string, unknown> } }
  }
  return { ctx, slots, binding, sessionFake, sessionsFake, layoutFake, mint, entryOf }
}

describe('conversation slot inject surface', () => {
  it('assembles the full surface and pulls history through the watch signal', async () => {
    const b = await bench()
    const injected = b.entryOf('conversation').options.inject(b.binding) as {
      useAncestry: () => readonly { id: SessionId }[]
      views: { list(): readonly ViewEntry[]; version(): number; subscribe(fn: () => void): () => void }
      useActiveView: () => string | undefined
      composer: { useDraft: () => string; setDraft(t: string): void; send(m: string): void; stop(): void }
      actions: { openView(v: string): void; open(id: SessionId): void }
      renderView: (entry: ViewEntry) => unknown
    }
    expect(b.sessionFake.open).toHaveBeenCalledTimes(1)
    expect(injected.views.list().map(v => v.id)).toEqual(['chat'])
    injected.actions.openView('chat')
    expect(b.layoutFake.openView).toHaveBeenCalledWith(ROOT, 'chat')
    injected.actions.open(ROOT)
    expect(b.layoutFake.open).toHaveBeenCalledWith(ROOT)
  })

  it('composer send trims, optimistically clears, and restores on failure; stop swallows rejection', async () => {
    const b = await bench()
    const injected = b.entryOf('conversation').options.inject(b.binding) as {
      composer: { setDraft(t: string): void; send(m: 'queue'): void; stop(): void }
    }
    const scoped = b.mint(ROOT).get('conversation') as ConversationService
    // Whitespace-only draft: no send.
    scoped.drafts.set('   ')
    injected.composer.send('queue')
    expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    // Success: cleared and stays cleared.
    injected.composer.setDraft('hello')
    injected.composer.send('queue')
    expect(scoped.drafts.getSnapshot()).toBe('')
    await Promise.resolve()
    expect(b.sessionFake.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    // Failure: restored (draft still empty when the rejection lands).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b' } })
    injected.composer.setDraft('retry me')
    injected.composer.send('queue')
    await vi.waitFor(() => {
      expect(scoped.drafts.getSnapshot()).toBe('retry me')
    })
    // Failure with new typing: no clobber.
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b' } })
    injected.composer.send('queue')
    injected.composer.setDraft('typed during flight')
    await new Promise(r => setTimeout(r, 0))
    expect(scoped.drafts.getSnapshot()).toBe('typed during flight')
    // Stop failure is swallowed (promptError owns the surface).
    b.sessionFake.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x' } })
    injected.composer.stop()
    await new Promise(r => setTimeout(r, 0))
  })

  it('view actions forward: openDetails writes selection through the scoped service, loadOlder hits the session', async () => {
    const b = await bench()
    const injected = b.entryOf('conversation').options.inject(b.binding) as {
      // viewProps rides renderView's closure; reach the actions through a rendered entry.
      renderView: (entry: ViewEntry) => React.ReactNode
    }
    let captured: { openDetails(t: { turnSeq: number; callId?: string }): void; loadOlder(): void } | undefined
    const Probe = (p: { actions: typeof captured }) => {
      captured = p.actions
      return null
    }
    render(createElement('div', null, injected.renderView({
      id: 'chat', label: 'Chat', component: Probe,
    } as unknown as ViewEntry)))
    captured!.openDetails({ turnSeq: 2, callId: 'c1' })
    expect(b.layoutFake.openDetails).toHaveBeenCalledTimes(1)
    const scoped = b.mint(ROOT).get('conversation') as import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationService
    expect(scoped.selection.getSnapshot()).toEqual({ turnSeq: 2, callId: 'c1' })
    captured!.loadOlder()
    expect(b.sessionFake.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('renderView mounts chrome header/footer around the view body', async () => {
    const b = await bench()
    const injected = b.entryOf('conversation').options.inject(b.binding) as {
      renderView: (entry: ViewEntry) => React.ReactNode
    }
    const entry = {
      id: 'chat', label: 'Chat',
      component: () => createElement('div', { 'data-testid': 'body' }),
      chrome: {
        header: () => createElement('div', { 'data-testid': 'hd' }),
        footer: () => createElement('div', { 'data-testid': 'ft' }),
      },
    } as unknown as ViewEntry
    const view = render(createElement('div', null, injected.renderView(entry)))
    expect(view.getByTestId('hd')).toBeTruthy()
    expect(view.getByTestId('body')).toBeTruthy()
    expect(view.getByTestId('ft')).toBeTruthy()
    // Ancestry and draft/active-view hooks execute inside a component tree.
    const HookProbe = () => {
      const injected2 = b.entryOf('conversation').options.inject(b.binding) as {
        useAncestry: () => readonly { title: string }[]
        useActiveView: () => string | undefined
        composer: { useDraft: () => string }
      }
      const chain = injected2.useAncestry()
      const active = injected2.useActiveView()
      const draft = injected2.composer.useDraft()
      return createElement('i', { 'data-testid': 'probe' }, `${chain.length}|${active ?? 'none'}|${draft}`)
    }
    const probe = render(createElement(HookProbe))
    // Draft content carries over from the composer case (per-scope store is
    // process-resident); the probe asserts hook wiring, not draft value.
    expect(probe.getByTestId('probe').textContent).toMatch(/^1\|none\|/)
    // A list-store update while mounted drives the ancestry selector's
    // shallowEqual arm (same derived chain → short-circuit, no re-render churn).
    await act(async () => {
      b.sessionsFake.list.update((d: { byId: Record<string, { updatedAt: number }> }) => {
        d.byId[ROOT]!.updatedAt = 2
      })
    })
    expect(probe.getByTestId('probe').textContent).toMatch(/^1\|none\|/)
    // The views read-face triple forwards to the service registry.
    const injected3 = b.entryOf('conversation').options.inject(b.binding) as {
      views: { list(): readonly { id: string }[]; subscribe(fn: () => void): () => void; version(): number }
    }
    expect(injected3.views.list().map(v => v.id)).toEqual(['chat'])
    const beforeVersion = injected3.views.version()
    const listener = vi.fn()
    const unsub = injected3.views.subscribe(listener)
    const conversation = b.ctx.get('conversation') as import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationService
    const offExtra = conversation.registerView({ id: 'chat2', label: 'X', component: () => null } as never)
    expect(listener).toHaveBeenCalled()
    expect(injected3.views.version()).toBeGreaterThan(beforeVersion)
    offExtra()
    unsub()
  })
})

describe('details and empty inject surfaces', () => {
  it('details surface wires selection and closeDetails', async () => {
    const b = await bench()
    const injected = b.entryOf('details').options.inject(b.binding) as {
      useSelection: unknown
      actions: { closeDetails(): void }
    }
    expect(injected.useSelection).toBeTypeOf('function')
    injected.actions.closeDetails()
    expect(b.layoutFake.closeDetails).toHaveBeenCalledTimes(1)
  })

  it('empty surface derives the deduped cwd set with a per-state cache and starts sessions', async () => {
    const b = await bench()
    const injected = b.entryOf('conversation.empty').options.inject({ ctx: b.ctx }) as {
      useCwds: (sel: (s: readonly string[]) => unknown, eq?: unknown) => unknown
      actions: { startSession(opts: { text: string; mode: 'queue' }): Promise<void> }
    }
    const CwdsProbe = () => {
      const cwds = injected.useCwds(s => s) as readonly string[]
      return createElement('i', { 'data-testid': 'cwds' }, cwds.join(','))
    }
    const view = render(createElement(CwdsProbe))
    expect(view.getByTestId('cwds').textContent).toBe('/proj')
    await injected.actions.startSession({ text: 'go', mode: 'queue' })
    expect(b.sessionsFake.create).toHaveBeenCalled()
  })
})
