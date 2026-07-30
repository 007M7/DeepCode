// @vitest-environment jsdom
// StatsLine (composer.dock entry): totals derivation + the RFC
// hard acceptance — zero renders during streaming. Bash sample row: the
// canonical sub-agent differential decided INSIDE the component off the
// standard useSessions kit (no registry predicates — tool ring dissolved).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type {
  AssistantMessageNode, ConversationSnapshot, SessionId, SessionListState, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { ToolRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { StatsLine, deriveStats, formatDuration, formatTokens, type StatsLineProps } from '../src/client/chat/StatsLine.tsx'
import { BashRow } from '../src/client/toolviews/bash-sample.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
  ...(usage === undefined ? {} : { usage }),
})

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

function makeSource(init?: Partial<ConversationSnapshot>) {
  let snap: ConversationSnapshot = { ...snapshotBase(), ...init }
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<ConversationSnapshot>) => {
      snap = { ...snap, ...next }
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

describe('deriveStats', () => {
  it('folds turns/steps/token split and cache hit percentage', () => {
    const stats = deriveStats([
      assistant(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }),
      assistant(2, 1, { inputTokens: 100, outputTokens: 50 }),
      assistant(3, 2),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
    expect(stats.inputTokens).toBe(1100)
    expect(stats.outputTokens).toBe(100)
    expect(stats.cacheHitPct).toBe(82)
  })

  it('cache hit stays null with no cache accounting; out-of-window tool results ignored', () => {
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
      isError: false, callView: null, resultView: null,
    }
    const stats = deriveStats([tool, assistant(1, 1)])
    expect(stats.steps).toBe(1)
    expect(stats.toolMs).toBe(0)
    expect(stats.cacheHitPct).toBeNull()
  })

  it('sums LLM wall time from assistant timing and tool wall time from call/result pairs', () => {
    const timed: AssistantMessageNode = {
      ...assistant(1, 1),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: 3_500 },
    }
    const untimed: AssistantMessageNode = {
      ...assistant(2, 1),
      timing: { stepStartTime: null, firstTokenTime: null, completedTime: 9_000 },
    }
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 7_000, callId: 'c', call: null, callTime: 4_000, content: [],
      isError: false, callView: null, resultView: null,
    }
    const stats = deriveStats([timed, untimed, tool])
    expect(stats.llmMs).toBe(2_500)
    expect(stats.toolMs).toBe(3_000)
  })
})

describe('formatters', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(517)).toBe('517')
    expect(formatTokens(12_240)).toBe('12.2K')
    expect(formatTokens(517_000)).toBe('517K')
    expect(formatTokens(1_230_000)).toBe('1.2M')
  })

  it('formats durations under and over a minute', () => {
    expect(formatDuration(45_230)).toBe('45.2s')
    expect(formatDuration(162_000)).toBe('2m42s')
  })
})

describe('StatsLine', () => {
  function props(source: { getSnapshot(): ConversationSnapshot; subscribe(fn: () => void): () => void }): StatsLineProps {
    return { useSession: bindSnapshotSelector(source) }
  }

  it('renders the grouped stats row and hides with zero steps', () => {
    const { source } = makeSource({
      nodes: [assistant(1, 1, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 })],
    })
    const view = render(<StatsLine {...props(source)} />)
    // No timing on the fixture: the duration group drops out whole.
    expect(view.container.textContent).toBe('1 turns · 1 steps|Cache hit 90%|Input 100 tok · Output 5 tok')
    const empty = makeSource()
    const emptyView = render(<StatsLine {...props(empty.source)} />)
    expect(emptyView.container.textContent).toBe('')
  })

  it('renders ZERO times during streaming chunk frames (RFC hard acceptance)', () => {
    const { set, source } = makeSource({ nodes: [assistant(1, 1)] })
    let renders = 0
    function Counting(p: StatsLineProps) {
      renders += 1
      return <StatsLine {...p} />
    }
    render(<Counting {...props(source)} />)
    const before = renders
    // Chunk frames swap partial only; nodes keeps its reference (object-layer contract).
    act(() => { set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'a' }] } }) })
    act(() => { set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'ab' }] } }) })
    act(() => { set({ running: true }) })
    expect(renders).toBe(before)
  })
})

describe('bash sample row', () => {
  const ROOT = 'root-1' as SessionId
  const CHILD = 'child-1' as SessionId

  const result = (callId: string): ToolResultNode => ({
    kind: 'tool-result', seq: 3, time: 3_000, callId,
    call: { name: 'bash', argsRaw: '{"command":"make build","description":"Build"}' },
    callTime: 2_000,
    content: [], isError: false, callView: null, resultView: null,
  })

  /** Real list-store engine: the family fixture the in-component parentId branch reads. */
  function listStore() {
    return createSnapshotStore<SessionListState>({
      ids: [ROOT, CHILD],
      byId: {
        [ROOT]: { id: ROOT, title: 'r', displayTitle: 'r', running: false, waitingApproval: false, blank: false, updatedAt: 0 },
        [CHILD]: { id: CHILD, title: 'c', displayTitle: 'c', parentId: ROOT, running: false, waitingApproval: false, blank: false, updatedAt: 0 },
      },
      current: undefined,
      phase: 'ready',
    })
  }

  const rowProps = (sessionId: SessionId, over?: {
    store?: ReturnType<typeof listStore>
  }): ToolRowProps => ({
    callId: 'c1', toolName: 'bash', block: result('c1'),
    openFile: vi.fn(),
    sessionId,
    useSessions: bindSnapshotSelector(over?.store ?? listStore()),
  } as unknown as ToolRowProps)

  it('differential rendering: the scoped variant in sub-sessions, global at roots', () => {
    const scoped = render(<BashRow {...rowProps(CHILD)} />)
    expect(scoped.container.querySelector('[data-sample="bash-scoped"]')).not.toBeNull()
    expect(scoped.getByText('scoped')).toBeTruthy()
    const plain = render(<BashRow {...rowProps(ROOT)} />)
    expect(plain.container.querySelector('[data-sample="bash-global"]')).not.toBeNull()
  })

  it('a session outside the list renders the global arm (no parent known)', () => {
    const view = render(<BashRow {...rowProps('gone' as SessionId)} />)
    expect(view.container.querySelector('[data-sample="bash-global"]')).not.toBeNull()
  })

  it('a live parentId write flips the row to the scoped variant (store subscription)', () => {
    const store = listStore()
    const orphan = 'late-child' as SessionId
    store.update((d) => {
      d.ids.push(orphan)
      d.byId[orphan] = { id: orphan, title: 'l', displayTitle: 'l', running: false, waitingApproval: false, blank: false, updatedAt: 0 }
    })
    const view = render(<BashRow {...rowProps(orphan, { store })} />)
    expect(view.container.querySelector('[data-sample="bash-global"]')).not.toBeNull()
    act(() => {
      store.update((d) => { d.byId[orphan]!.parentId = ROOT })
    })
    expect(view.container.querySelector('[data-sample="bash-scoped"]')).not.toBeNull()
  })

  it('summarizes as Bash · description on both arms without row click targets', () => {
    const global = render(<BashRow {...rowProps(ROOT)} />)
    // Two renders share document.body: query inside each container.
    const globalRow = global.container.querySelector('[data-sample="bash-global"]')!
    expect(globalRow.textContent).toContain('Bash')
    expect(globalRow.textContent).toContain('Build')
    expect(globalRow.getAttribute('data-clickable')).toBeNull()
    const scoped = render(<BashRow {...rowProps(CHILD)} />)
    const scopedRow = scoped.container.querySelector('[data-sample="bash-scoped"]')!
    expect(scopedRow.textContent).toContain('Bash')
    expect(scopedRow.textContent).toContain('Build')
    expect(scopedRow.getAttribute('data-clickable')).toBeNull()
  })
})
