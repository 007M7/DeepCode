// @vitest-environment jsdom
// StatsLine (chrome.footer first consumer): totals derivation + the RFC hard
// acceptance — zero renders during streaming. Bash sample: differential
// registry hits per session, teardown reverts to the generic row.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  AssistantMessageNode, ConversationSnapshot, SessionId, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { ChromeProps, ToolViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { StatsLine, deriveStats } from '../src/client/chat/StatsLine.tsx'
import { BashRow, ScopedBashRow, registerBashSamples } from '../src/client/toolviews/bash-sample.tsx'
import { ToolViewOutlet } from '../src/client/chat/ToolViewOutlet.tsx'
import { childSessionScope } from '../src/client/chat/register.ts'

afterEach(cleanup)

const SID = 's1' as SessionId

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNode => ({
  kind: 'assistant', seq, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
  ...(usage === undefined ? {} : { usage }),
})

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [],
    pending: [], running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, lastAgentError: null,
  }
}

function makeSource(init?: Partial<ConversationSnapshot>) {
  let snap: ConversationSnapshot = { ...snapshotBase(), ...init }
  const subs = new Set<() => void>()
  return {
    set(next: Partial<ConversationSnapshot>) {
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
  it('folds turns/steps/tokens and cache hit percentage', () => {
    const stats = deriveStats([
      assistant(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }),
      assistant(2, 1, { inputTokens: 100, outputTokens: 50 }),
      assistant(3, 2),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
    expect(stats.tokens).toBe(1200)
    expect(stats.cacheHitPct).toBe(82)
  })

  it('cache hit stays null with no cache accounting; non-assistant nodes ignored', () => {
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, callId: 'c', call: null, content: [],
      isError: false, callView: null, resultView: null,
    }
    const stats = deriveStats([tool, assistant(1, 1)])
    expect(stats.steps).toBe(1)
    expect(stats.cacheHitPct).toBeNull()
  })
})

describe('StatsLine', () => {
  function props(source: { getSnapshot(): ConversationSnapshot; subscribe(fn: () => void): () => void }): ChromeProps {
    return { sessionId: SID, useSession: bindSnapshotSelector(source) as unknown as UseSession }
  }

  it('renders the joined stats row and hides with zero steps', () => {
    const { source } = makeSource({
      nodes: [assistant(1, 1, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 })],
    })
    const view = render(<StatsLine {...props(source)} />)
    expect(view.getByText('cache hit 90% · 105 tokens · 1 turns · 1 steps')).toBeTruthy()
    const empty = makeSource()
    const emptyView = render(<StatsLine {...props(empty.source)} />)
    expect(emptyView.container.textContent).toBe('')
  })

  it('renders ZERO times during streaming chunk frames (RFC hard acceptance)', () => {
    const { set, source } = makeSource({ nodes: [assistant(1, 1)] })
    let renders = 0
    function Counting(p: ChromeProps) {
      renders += 1
      return <StatsLine {...p} />
    }
    render(<Counting {...props(source)} />)
    const before = renders
    // Chunk frames swap partial only; nodes keeps its reference (object-layer contract).
    act(() => set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'a' }] } }))
    act(() => set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'ab' }] } }))
    act(() => set({ running: true }))
    expect(renders).toBe(before)
  })
})

describe('bash toolview samples', () => {
  const result = (callId: string): ToolResultNode => ({
    kind: 'tool-result', seq: 3, callId,
    call: { name: 'bash', argsRaw: '{"command":"make build","description":"Build"}' },
    content: [], isError: false, callView: null, resultView: null,
  })

  const viewProps = (openDetails = vi.fn()): ToolViewProps => ({
    callId: 'c1', toolName: 'bash', block: result('c1'),
    useSession: (() => { throw new Error('unused') }) as unknown as UseSession,
    actions: { openDetails },
    t: (k) => k,
  })

  function outlet(registry: ToolViewRegistry, sessionId: SessionId, p = viewProps()) {
    return render(
      <ToolViewOutlet registry={registry} sessionId={sessionId} toolName="bash" viewProps={p} />,
    )
  }

  it('differential rendering: scoped row for the matching session, global elsewhere', () => {
    const registry = new ToolViewRegistry()
    registerBashSamples(registry, (id) => id === ('swarm' as SessionId))
    const scoped = outlet(registry, 'swarm' as SessionId)
    expect(scoped.container.querySelector('[data-sample="bash-scoped"]')).not.toBeNull()
    const plain = outlet(registry, SID)
    expect(plain.container.querySelector('[data-sample="bash-global"]')).not.toBeNull()
  })

  it('teardown removes both registrations and falls back to the generic row', () => {
    const registry = new ToolViewRegistry()
    const off = registerBashSamples(registry, () => true)
    const view = outlet(registry, SID)
    expect(view.container.querySelector('[data-sample="bash-scoped"]')).not.toBeNull()
    act(() => off())
    expect(view.container.querySelector('[data-sample]')).toBeNull()
    expect(view.getByText('Bash')).toBeTruthy()
  })

  it('childSessionScope matches sub-sessions via the injected list read face', () => {
    const child = 'child' as SessionId
    const root = 'root' as SessionId
    const scope = childSessionScope({
      getSnapshot: () => ({
        ids: [root, child],
        byId: {
          [root]: { id: root, title: 'r', running: false, updatedAt: 0 },
          [child]: { id: child, title: 'c', parentId: root, running: false, updatedAt: 0 },
        },
      }),
    })
    expect(scope(child)).toBe(true)
    expect(scope(root)).toBe(false)
    expect(scope('gone' as SessionId)).toBe(false)
  })

  it('sample rows summarize the command and hand clicks to openDetails', () => {
    const open = vi.fn()
    const p = viewProps(open)
    const global = render(<BashRow {...p} />)
    expect(global.getByText('Build')).toBeTruthy()
    fireEvent.click(global.getByText('Build'))
    expect(open).toHaveBeenCalledTimes(1)
    const scoped = render(<ScopedBashRow {...p} />)
    expect(scoped.getByText('scoped')).toBeTruthy()
  })
})
