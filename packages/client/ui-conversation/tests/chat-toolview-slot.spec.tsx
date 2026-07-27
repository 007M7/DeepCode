// @vitest-environment jsdom
// The dissolved tool ring's acceptance chain on the REAL machinery stack:
// cordis Context + SlotsService ledger + the web-react renderer + this
// package's own apply — no outlet twins. Proves the keyed
// 'conversation.chat.toolview' hole end to end: registered rows dispatch by
// entryKey (the bash sample lands through its plugin), unregistered tools
// fall back to GenericToolCard at the render site, live registration/unload
// flips rows in place, duplicate keys fail loud, the inject channel feeds
// (sessionId) => I into row components, and a registrant's
// inject: ['slots', 'conversation'] load-order seam suspends on real fiber
// semantics until the service (and with it the hole declaration) is present.

import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createSnapshotStore, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, SessionId, SessionListState, ToolResultNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

const SID = 's1' as SessionId

afterEach(cleanup)
// The chat store persists under its declared key; clear between cases.
beforeEach(() => {
  localStorage.clear()
})

const toolResult = (seq: number, callId: string, name: string, args = '{"command":"make build","description":"Build"}'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: args },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, callView: null, resultView: null,
})

function snapshotWith(nodes: ToolResultNode[]): ConversationSnapshot {
  return {
    sessionId: SID, nodes, foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue: [], todos: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

/** Test-owned AppFrame role: declares and renders the resident conversation area. */
type AppRootProps = PropsRenderSlots<'conversation' | 'details'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('conversation', {})}</>
}

/**
 * Real-stack bench: SlotsService plugin, renderer installed, sessions/layout
 * fakes at the service seams only (external boundaries), the package apply on
 * its own fiber, and the test AppFrame occupying 'root'.
 */
async function bench(nodes: ToolResultNode[]) {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotsService)
  await slotsFiber.await()
  const slots = ctx.get('slots') as SlotsService

  const session = createSnapshotStore<ConversationSnapshot>(snapshotWith(nodes))
  const list = createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, title: 'S', displayTitle: 'S', running: false, blank: false, updatedAt: 1 } },
    current: SID,
    phase: 'ready',
  })
  // Identity-stable provide bundle: the renderer caches hooks per source and
  // inject results per bundle, both by object identity. Registered providers
  // (the package's input contribution) materialize into it lazily, once.
  const providers: ((binding: object) => { hooks?: object; props?: object })[] = []
  let info: { sessionId: SessionId; hooks: object; props: object } | undefined
  const scoped = { send: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
  const actxFake = { get: () => scoped, effect: () => {}, on: () => () => {} }
  const bindingOf = (id: SessionId) => ({
    sessionId: id,
    ctx: actxFake,
    session: {
      sessionId: id,
      loadOlder: vi.fn(),
      prompt: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
      // Observable face for the input machine's queue read face.
      getSnapshot: () => session.getSnapshot(),
      subscribe: (fn: () => void) => session.subscribe(fn),
    },
  })
  ctx.provide('sessions', {
    list,
    binding: bindingOf,
    scope: () => actxFake,
    provideInfo: (id: string) => {
      if (id !== SID) return undefined
      if (info === undefined) {
        const hooks: Record<string, unknown> = { session }
        const props: Record<string, unknown> = {}
        for (const provider of providers) {
          const c = provider(bindingOf(SID))
          Object.assign(hooks, c.hooks ?? {})
          Object.assign(props, c.props ?? {})
        }
        info = { sessionId: SID, hooks, props }
      }
      return info
    },
    maybeProvideInfo(id: string | undefined) {
      // `this` inside an object-literal method is any under strict lint; the
      // fake resolves through its own provideInfo above.
      /* eslint-disable-next-line @typescript-eslint/no-unsafe-return,
         @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
      return (id === undefined ? undefined : this.provideInfo(id)) ?? { hooks: {}, props: {} }
    },
    provide: (d: { resolve: (typeof providers)[number] }) => { providers.push(d.resolve); return () => {} },
    scopeOf: () => SID,
    create: vi.fn(),
    open: vi.fn(),
    updateIntent: vi.fn(),
  })
  ctx.provide('workspaces', {
    list: createSnapshotStore<WorkspaceListState>({
      items: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    }),
    startSession: vi.fn(),
    sendSession: vi.fn(),
  })
  ctx.provide('layout', layout)
  ctx.provide('locale', { bind: () => (key: string) => key })

  slots.install(createSlotRenderer())
  slots.register({
    name: 'root',
    children: {
      'conversation': { kind: 'single', scope: 'session-maybe' },
      'details': { kind: 'single', scope: 'session' },
    },
  }, AppRoot)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber, session, list, layout }
}

/** Render the whole tree through the ctx-level root seam (the shell's own entry). */
function mountApp(slots: SlotsService) {
  return render(<>{slots.renderSlot('root', {})}</>)
}

describe('keyed toolview hole through the real machinery', () => {
  it('dispatches registered rows by entryKey and unregistered tools to the GenericToolCard fallback', async () => {
    const b = await bench([
      toolResult(3, 'c1', 'bash'),
      toolResult(4, 'c2', 'mystery', '{"n":1}'),
    ])
    const view = mountApp(b.slots)
    // bash: the sample plugin's keyed registration took the row (root
    // session → global arm, decided inside the component off useSessions).
    expect(view.container.querySelector('[data-sample="bash-global"]')).not.toBeNull()
    expect(view.getByText('Bash')).toBeTruthy()
    expect(view.getByText('Build')).toBeTruthy()
    // mystery: no registration under that key → render-site fallback.
    expect(view.getByText('Tool call')).toBeTruthy()
  })

  it('row clicks travel owner openDetails → chat inject → layout orchestration', async () => {
    const b = await bench([toolResult(3, 'c1', 'bash')])
    const view = mountApp(b.slots)
    view.getByText('Build').click()
    expect(b.layout.openDetails).toHaveBeenCalledTimes(1)
  })

  it('a live keyed registration takes over its tool row and unload reverts to the fallback', async () => {
    const b = await bench([toolResult(3, 'c2', 'mystery', '{"n":1}')])
    const view = mountApp(b.slots)
    expect(view.getByText('Tool call')).toBeTruthy()
    let dispose = (): void => {}
    await act(async () => {
      dispose = b.slots.register(
        { name: 'conversation.chat.toolview', key: 'mystery' },
        () => <div data-testid="mystery-row" />)
    })
    // Per-key version tick: the row flipped without a remount of the view.
    expect(view.getByTestId('mystery-row')).toBeTruthy()
    expect(view.queryByText('Tool call')).toBeNull()
    await act(async () => { dispose() })
    expect(view.queryByTestId('mystery-row')).toBeNull()
    expect(view.getByText('Tool call')).toBeTruthy()
  })

  it('a duplicate key registration fails loud at load', async () => {
    const b = await bench([])
    expect(() => b.slots.register(
      { name: 'conversation.chat.toolview', key: 'bash' },
      () => null,
    )).toThrow(/key "bash"/)
  })

  it('the inject channel feeds (sessionId) => I into the row component', async () => {
    const b = await bench([toolResult(3, 'c3', 'probe', '{"x":1}')])
    const poked: string[] = []
    b.slots.register({
      name: 'conversation.chat.toolview',
      key: 'probe',
      // Two-way business face: data derived from the session id out, a
      // callback closing over it back in — the askuser-pattern inject shape.
      inject: (sessionId: SessionId) => ({
        mark: `for:${sessionId}`,
        poke: () => { poked.push(sessionId) },
      }),
    }, ({ mark, poke }: ToolRowProps & { mark: string; poke: () => void }) => (
      <button data-testid="probe-row" onClick={poke}>{mark}</button>
    ))
    const view = mountApp(b.slots)
    const row = view.getByTestId('probe-row')
    expect(row.textContent).toBe(`for:${SID}`)
    row.click()
    expect(poked).toEqual([SID])
  })
})

describe('registrant load-order seam', () => {
  it("suspends a registrant on inject: ['slots', 'conversation'] until the service (and the hole) exists", async () => {
    const ctx = new Context()
    const slotsFiber = ctx.plugin(SlotsService)
    await slotsFiber.await()
    const slots = ctx.get('slots') as SlotsService
    ctx.provide('sessions', {
      list: createSnapshotStore<SessionListState>({
        ids: [], byId: {}, current: undefined, phase: 'ready',
      }),
      binding: () => undefined,
      scope: () => undefined,
      provideInfo: () => undefined,
      maybeProvideInfo: () => ({ hooks: {}, props: {} }),
      provide: () => () => {},
      create: vi.fn(),
      open: vi.fn(),
      updateIntent: vi.fn(),
    })
    ctx.provide('workspaces', {
      list: createSnapshotStore<WorkspaceListState>({
        items: [], state: 'idle', phase: 'ready', error: null,
        baselinesReady: true, recentWorkspaceId: undefined,
      }),
      startSession: vi.fn(),
      sendSession: vi.fn(),
    })
    ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    ctx.provide('locale', { bind: () => (key: string) => key })
    slots.register({
      name: 'root',
      children: {
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
      },
    }, AppRoot)

    // Third-party posture, mounted BEFORE ui-conversation: real fiber inject
    // semantics hold it — apply must not run while 'conversation' is absent.
    // (Plain arrow, not vi.fn: mock functions carry a prototype and trip the
    // fiber's isConstructor branch.)
    let applyRuns = 0
    const registrantApply = (registrantCtx: Context): void => {
      applyRuns += 1
      registrantCtx.slots.register(
        { name: 'conversation.chat.toolview', key: 'late' }, () => null)
    }
    const late = ctx.plugin({
      name: 'late-registrant',
      inject: ['slots', 'conversation'],
      apply: registrantApply,
    })
    await Promise.resolve()
    expect(applyRuns).toBe(0)

    // Mounting the package resolves the seam: service present ⟹ the chat
    // entry (and its hole declaration) is already on the ledger, so the
    // suspended registrant lands without an undeclared-slot throw.
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await late.await()
    expect(applyRuns).toBe(1)
    expect(slots.entries('conversation.chat.toolview').map(e => e.options.key))
      .toEqual(expect.arrayContaining(['bash', 'late']))
  })
})
