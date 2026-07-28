// @vitest-environment jsdom
// StatsLine (rendered inside the chat view body): durable metrics presentation + the RFC
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
import {
  cacheHitPercent, contextPercent, deriveVisibleCounts, formatMetricTokens,
  StatsLine, type StatsLineProps,
} from '../src/client/chat/StatsLine.tsx'
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
    pending: [], queue: [], todos: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null, metrics: null,
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

describe('stats derivation', () => {
  it('counts visible turns and steps without reading node usage', () => {
    const stats = deriveVisibleCounts([
      assistant(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }),
      assistant(2, 1, { inputTokens: 100, outputTokens: 50 }),
      assistant(3, 2),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
  })

  it('ignores non-assistant nodes', () => {
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
      isError: false, callView: null, resultView: null,
    }
    const stats = deriveVisibleCounts([tool, assistant(1, 1)])
    expect(stats.steps).toBe(1)
  })

  it('keeps the cache formula disjoint from cache writes and rounds/clamps context like the TUI', () => {
    const durable = {
      logRevision: 20,
      projectionRevision: 2,
      uncachedInputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 50_000,
      contextTokens: 34_500,
      contextWindow: 100_000,
    }
    expect(cacheHitPercent(durable)).toBe(90)
    expect(contextPercent(durable)).toBe(35)
    expect(contextPercent({ ...durable, contextTokens: 200_000 })).toBe(100)
    const { contextWindow: _contextWindow, ...withoutContextWindow } = durable
    expect(contextPercent(withoutContextWindow)).toBeNull()
    expect(cacheHitPercent({ ...durable, uncachedInputTokens: 0, cacheReadTokens: 0 })).toBeNull()
  })

  it('formats large values compactly in the existing en-US style', () => {
    expect(formatMetricTokens(999)).toBe('999')
    expect(formatMetricTokens(15_962)).toBe('16k')
    expect(formatMetricTokens(2_172_544)).toBe('2.2m')
  })
})

describe('StatsLine', () => {
  function props(source: { getSnapshot(): ConversationSnapshot; subscribe(fn: () => void): () => void }): StatsLineProps {
    return { useSession: bindSnapshotSelector(source) }
  }

  it('renders separate durable counters, cache hit, context occupancy, and visible counts', () => {
    const { source } = makeSource({
      nodes: [assistant(1, 1, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 })],
      metrics: {
        logRevision: 30,
        projectionRevision: 4,
        uncachedInputTokens: 120_237,
        outputTokens: 13_881,
        cacheReadTokens: 2_172_544,
        cacheWriteTokens: 99_999,
        contextTokens: 89_600,
        contextWindow: 256_000,
      },
    })
    const view = render(<StatsLine {...props(source)} />)
    expect(view.getByText(
      '120.2k uncached input · 13.9k output · 2.2m cache read · cache hit 95% · context 35% of 256k · 1 turns · 1 steps',
    )).toBeTruthy()
    const empty = makeSource()
    const emptyView = render(<StatsLine {...props(empty.source)} />)
    expect(emptyView.container.textContent).toBe('')
  })

  it('renders durable counters without a percentage before live capacity is observed', () => {
    const { source } = makeSource({
      nodes: [assistant(1, 1)],
      metrics: {
        logRevision: 4,
        projectionRevision: 1,
        uncachedInputTokens: 120,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        contextTokens: 8_000,
      },
    })
    const view = render(<StatsLine {...props(source)} />)
    expect(view.getByText(
      '120 uncached input · 20 output · 30 cache read · cache hit 20% · context unknown · 1 turns · 1 steps',
    )).toBeTruthy()
    expect(view.container.textContent).not.toContain('% of')
  })

  it('renders honest unknowns when the host projection is missing', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source)} />)
    expect(view.getByText('usage unknown · context unknown · 1 turns · 1 steps')).toBeTruthy()
  })

  it.each([
    { uncachedInputTokens: 1, outputTokens: 0, cacheReadTokens: 0, contextTokens: 0 },
    { uncachedInputTokens: 0, outputTokens: 1, cacheReadTokens: 0, contextTokens: 0 },
    { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 1, contextTokens: 0 },
    { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, contextTokens: 1 },
  ])('keeps a metrics-only row visible for each nonzero projection bucket', (nonzero) => {
    const { source } = makeSource({
      metrics: {
        logRevision: 1,
        projectionRevision: 0,
        cacheWriteTokens: 0,
        ...nonzero,
      },
    })
    const view = render(<StatsLine {...props(source)} />)
    expect(view.container.textContent).toContain('0 turns · 0 steps')
  })

  it('renders ZERO times during streaming chunk frames (RFC hard acceptance)', () => {
    const { set, source } = makeSource({
      nodes: [assistant(1, 1)],
      metrics: {
        logRevision: 4,
        projectionRevision: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
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
        [ROOT]: { id: ROOT, title: 'r', displayTitle: 'r', running: false, blank: false, updatedAt: 0 },
        [CHILD]: { id: CHILD, title: 'c', displayTitle: 'c', parentId: ROOT, running: false, blank: false, updatedAt: 0 },
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
      d.byId[orphan] = { id: orphan, title: 'l', displayTitle: 'l', running: false, blank: false, updatedAt: 0 }
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
