// @vitest-environment jsdom
// Code Mode sub-call acceptance on the REAL machinery stack (same bench as
// chat-toolview-slot.spec): a run_code result renders the 'code' variant row
// (description summary, program body), its logged sub-dispatches render as
// always-visible nested rows through the SAME keyed toolview hole — the bash
// sub-call lands in the bash sample plugin's registration exactly like a
// top-level bash row, unregistered sub-tools fall back to GenericToolCard —
// and a sub-row click opens details for the sub-callId. Running parents
// (runningCalls) nest their so-far dispatches the same way.

import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CodeSubCall, ConversationSnapshot, RunningToolCall, SessionId, SessionListState,
  ToolResultNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

const SID = 's1' as SessionId

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
})

const PROGRAM = 'const listing = await tools.bash({ command: "ls notes", description: "List notes" })\nreturn listing'
const RUN_CODE_ARGS = JSON.stringify({ code: PROGRAM, description: 'List the notes directory' })

const codeResult = (seq: number, callId: string): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name: 'run_code', argsRaw: RUN_CODE_ARGS },
  callTime: seq * 1_000 - 500,
  content: [{ type: 'text', text: 'demo.txt' }], isError: false, callView: null, resultView: null,
})

const runningCode = (callId: string): RunningToolCall => ({
  callId, name: 'run_code', argsRaw: RUN_CODE_ARGS, turn: 9, step: 0, time: 9_000, callView: null,
})

const subCall = (seq: number, parent: string, n: number, name: string, args: object, resultText: string, isError = false): CodeSubCall => ({
  kind: 'tool-result', seq, time: seq * 1_000,
  callId: `${parent}:code:${n}`,
  call: { name, argsRaw: JSON.stringify(args) },
  callTime: seq * 1_000,
  content: [{ type: 'text', text: resultText }], isError, callView: null, resultView: null,
})

function snapshotWith(
  nodes: ToolResultNode[],
  codeDispatches: ReadonlyMap<string, readonly CodeSubCall[]>,
  runningCalls: RunningToolCall[] = [],
): ConversationSnapshot {
  return {
    sessionId: SID, nodes, foldDegraded: false, partial: null, runningCalls, codeDispatches,
    pending: [], running: runningCalls.length > 0, composerPhase: 'active', removed: false,
    openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, intent: null, pendingPrompt: null, lastAgentError: null,
  } as ConversationSnapshot
}

/** Test-owned AppFrame role: declares the layout-owned children and renders the conversation area under the framework session provider. */
type AppRootProps = PropsRenderSlots<'conversation' | 'details' | 'conversation.empty'>
function AppRoot({ renderSlot, SessionProvider }: AppRootProps) {
  return <SessionProvider>{() => renderSlot('conversation', {})}</SessionProvider>
}

/** Same real-stack bench as the toolview-slot spec: SlotsService + renderer + this package's apply; fakes only at service seams. */
async function bench(snapshot: ConversationSnapshot) {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotsService)
  await slotsFiber.await()
  const slots = ctx.get('slots') as SlotsService

  const session = createSnapshotStore<ConversationSnapshot>(snapshot)
  const list = createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, title: 'S', displayTitle: 'S', running: false, updatedAt: 1 } },
    current: SID,
    intent: undefined,
    phase: 'ready',
  })
  const cell = { sessionId: SID, session }
  const scoped = { send: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
  ctx.provide('sessions', {
    list,
    binding: (id: SessionId) => ({ sessionId: id, session: { loadOlder: vi.fn() } }),
    scope: () => ({ get: () => scoped }),
    cell: (id: string) => (id === SID ? cell : undefined),
    create: vi.fn(),
    open: vi.fn(),
    updateIntent: vi.fn(),
  })
  ctx.provide('workspaces', {
    list: createSnapshotStore<WorkspaceListState>({
      items: [], intent: undefined, state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    }),
    startSession: vi.fn(),
    sendSession: vi.fn(),
  })
  ctx.provide('layout', layout)
  ctx.provide('i18n', { bind: () => (key: string) => key })

  slots.install(createSlotRenderer())
  slots.register({
    name: 'root',
    children: {
      'conversation': { kind: 'single', scope: 'session' },
      'details': { kind: 'single', scope: 'session' },
      'conversation.empty': { kind: 'single', scope: 'root' },
    },
  }, AppRoot)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber, session, layout }
}

function mountApp(slots: SlotsService) {
  return render(<>{slots.renderSlot('root', {})}</>)
}

describe('run_code sub-calls through the real chat machinery', () => {
  it('renders the code-variant parent row with the description summary and nested sub-rows', async () => {
    const parent = 'call-64'
    const dispatches = new Map([[parent, [
      subCall(11, parent, 1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
      subCall(12, parent, 2, 'mystery', { n: 1 }, 'ok'),
    ]]])
    const b = await bench(snapshotWith([codeResult(10, parent)], dispatches))
    const view = mountApp(b.slots)

    // Parent row: the code variant with the model-authored description.
    const codeRoot = view.container.querySelector('[data-variant="code"]')
    expect(codeRoot).not.toBeNull()
    expect(view.getByText('Code')).toBeTruthy()
    expect(view.getByText('List the notes directory')).toBeTruthy()

    // Nested rows are ALWAYS visible (no parent expand needed): the bash
    // sub-call landed in the bash sample plugin's keyed registration — the
    // exact component a native top-level bash row uses — and the unregistered
    // sub-tool fell back to GenericToolCard at the same render site.
    const nest = view.container.querySelector('[data-subcalls]')
    expect(nest).not.toBeNull()
    expect(nest!.querySelector('[data-sample="bash-global"]')).not.toBeNull()
    expect(view.getByText('List notes')).toBeTruthy()
    expect(view.getByText('Tool call')).toBeTruthy()
  })

  it('expanding the code row reveals the program body verbatim', async () => {
    const parent = 'call-64'
    const b = await bench(snapshotWith([codeResult(10, parent)], new Map()))
    const view = mountApp(b.slots)
    // The code row is expandable via its leading control (body = the program).
    const toggle = view.container.querySelector('[data-variant="code"] button[aria-expanded]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle!)
    expect(view.getByText(/const listing = await tools\.bash/)).toBeTruthy()
  })

  it('an isError sub-call renders the error state dot exactly like a failed native row', async () => {
    const parent = 'call-64'
    const dispatches = new Map([[parent, [
      subCall(11, parent, 1, 'mystery', { n: 1 }, 'Error: boom', true),
    ]]])
    const b = await bench(snapshotWith([codeResult(10, parent)], dispatches))
    const view = mountApp(b.slots)
    const nested = view.container.querySelector('[data-subcalls] [data-variant][data-state="error"]')
    expect(nested).not.toBeNull()
  })

  it('a sub-row click opens details for the sub-callId', async () => {
    const parent = 'call-64'
    const dispatches = new Map([[parent, [
      subCall(11, parent, 1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
    ]]])
    const b = await bench(snapshotWith([codeResult(10, parent)], dispatches))
    const view = mountApp(b.slots)
    view.getByText('List notes').click()
    expect(b.layout.openDetails).toHaveBeenCalledTimes(1)
  })

  it('a RUNNING run_code call nests its so-far dispatches under the spinner row', async () => {
    const parent = 'call-live'
    const dispatches = new Map([[parent, [
      subCall(21, parent, 1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
    ]]])
    const b = await bench(snapshotWith([], dispatches, [runningCode(parent)]))
    const view = mountApp(b.slots)
    const running = view.container.querySelector('[data-variant="code"][data-state="running"]')
    expect(running).not.toBeNull()
    const nest = view.container.querySelector('[data-subcalls]')
    expect(nest).not.toBeNull()
    expect(nest!.querySelector('[data-sample="bash-global"]')).not.toBeNull()
  })

  it('an ordinary tool row renders no sub-call nest', async () => {
    const parent = 'call-64'
    const plain: ToolResultNode = {
      kind: 'tool-result', seq: 10, time: 10_000, callId: parent,
      call: { name: 'mystery', argsRaw: '{"n":1}' },
      callTime: 9_500,
      content: [], isError: false, callView: null, resultView: null,
    }
    const b = await bench(snapshotWith([plain], new Map()))
    const view = mountApp(b.slots)
    expect(view.container.querySelector('[data-subcalls]')).toBeNull()
  })
})
