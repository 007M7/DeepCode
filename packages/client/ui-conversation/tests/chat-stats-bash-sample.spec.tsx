// @vitest-environment jsdom
// StatsLine (composer.dock entry): totals derivation + the RFC
// hard acceptance — zero renders during streaming. Bash sample row: ToolRow
// chrome (Bash · description) without a row click target.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type {
  AssistantMessageNode, ConversationSnapshot, SessionId, SessionListState, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { StatsLine, deriveStats, formatDuration, formatTokens, type StatsLineProps } from '../src/client/chat/StatsLine.tsx'
import { BashRow } from '../src/client/toolviews/bash-sample.tsx'
import { zh } from '../src/client/locales.ts'

type BashRowProps = Parameters<typeof BashRow>[0]

// Mirrors the real lookup chain (conversation namespace, then common).
const t: BashRowProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const SID = 's1' as SessionId

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
  ...(usage === undefined ? {} : { usage }),
})

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
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
  it('counts turns and steps and never folds node usage into accounting', () => {
    const stats = deriveStats([
      assistant(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }),
      assistant(2, 1, { inputTokens: 100, outputTokens: 50 }),
      assistant(3, 2),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
    // Window-scoped by design: the paged window is not an accounting source, so
    // the fold exposes no token fields at all (billing rides the projection).
    expect(Object.keys(stats).sort()).toEqual(['llmMs', 'steps', 'toolMs', 'turns'])
  })

  it('ignores tool results with no call time', () => {
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
      isError: false, callView: null, resultView: null,
    }
    const stats = deriveStats([tool, assistant(1, 1)])
    expect(stats.steps).toBe(1)
    expect(stats.toolMs).toBe(0)
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
  const USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }

  /** Stub the projection seat: a key-addressed table of whole values. */
  function projections(values: Record<string, unknown>): StatsLineProps['useProjection'] {
    return (key: string) => values[key]
  }

  function props(
    source: { getSnapshot(): ConversationSnapshot; subscribe(fn: () => void): () => void },
    values: Record<string, unknown> = { tokenUsage: USAGE },
  ): StatsLineProps {
    return { useSession: bindSnapshotSelector(source), useProjection: projections(values) }
  }

  it('renders the grouped stats row and hides a brand-new empty session', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source)} />)
    // No timing on the fixture: the duration group drops out whole. Tokens come
    // from the projection, so paging the window cannot change them.
    expect(view.container.textContent).toBe('1 turns · 1 steps|Cache hit 90%|Input 100 tok · Output 5 tok')
    const empty = makeSource()
    const emptyView = render(<StatsLine {...props(empty.source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextPressure: {},
    })} />)
    expect(emptyView.container.textContent).toBe('')
  })

  it('keeps durable token and context groups after the visible step window is empty', () => {
    const { source } = makeSource()
    const view = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
    })} />)
    expect(view.container.textContent)
      .toBe('Context 25% of 128K|Cache hit 90%|Input 100 tok · Output 5 tok')
  })

  it('renders context occupancy only when the projection knows a capacity', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const withCapacity = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
    })} />)
    expect(withCapacity.container.textContent).toContain('Context 25% of 128K')
    // Pressure without capacity has no denominator: the group drops out.
    const noCapacity = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      contextPressure: { pressureTokens: 32_000 },
    })} />)
    expect(noCapacity.container.textContent).not.toContain('Context')
    // Capacity arrives before usage in the log; no provider sample means there
    // is no numerator yet, rather than a synthetic 0%.
    const noPressure = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      contextPressure: { contextWindow: 128_000 },
    })} />)
    expect(noPressure.container.textContent).not.toContain('Context')
  })

  it('clamps occupancy at 100% when pressure exceeds the recorded capacity', () => {
    // Capacity and pressure are independent last-wins fields, so a model switch
    // can pair a smaller new window with the previous route's larger prompt.
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      contextPressure: { pressureTokens: 300_000, contextWindow: 128_000 },
    })} />)
    expect(view.container.textContent).toContain('Context 100% of 128K')
  })

  it('drops every token group when no projection is composed', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {})} />)
    expect(view.container.textContent).toBe('1 turns · 1 steps')
  })

  it('omits cache hit when nothing was billed on the input side', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })} />)
    expect(view.container.textContent).toBe('1 turns · 1 steps|Input 0 tok · Output 7 tok')
  })

  it('includes cache writes in billed input and the cache-hit denominator', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {
      tokenUsage: {
        uncachedInputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 90,
        cacheWriteTokens: 100,
      },
    })} />)
    expect(view.container.textContent)
      .toBe('1 turns · 1 steps|Cache hit 45%|Input 200 tok · Output 7 tok')
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
  const SID = 'root-1' as SessionId

  const result = (callId: string): ToolResultNode => ({
    kind: 'tool-result', seq: 3, time: 3_000, callId,
    call: { name: 'bash', argsRaw: '{"command":"make build","description":"Build"}' },
    callTime: 2_000,
    content: [], isError: false, callView: null, resultView: null,
  })

  function listStore() {
    return createSnapshotStore<SessionListState>({
      ids: [SID],
      byId: {
        [SID]: { id: SID, title: 'r', displayTitle: 'r', running: false, waitingApproval: false, blank: false, updatedAt: 0 },
      },
      current: undefined,
      phase: 'ready',
      subagentsByParent: {},
      currentAddress: undefined,
    })
  }

  const rowProps = (): BashRowProps => ({
    callId: 'c1', toolName: 'bash', block: result('c1'),
    openFile: vi.fn(),
    sessionId: SID,
    useSessions: bindSnapshotSelector(listStore()),
    t,
  } as unknown as BashRowProps)

  it('summarizes as Bash · description without a row click target', () => {
    const view = render(<BashRow {...rowProps()} />)
    const row = view.container.querySelector('[data-sample="bash"]')!
    expect(row.textContent).toContain('Bash')
    expect(row.textContent).toContain('Build')
    expect(row.getAttribute('data-clickable')).toBeNull()
  })
})
