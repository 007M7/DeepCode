// @vitest-environment jsdom
// Skeleton branch tails for the coverage gate (complements skeleton.spec.tsx
// acceptance flows): breadcrumb ancestry rendering + error strip in
// ConversationRoot, DetailsPanel non-JSON args / non-text result blocks /
// error-only results, EmptyState failure surface and custom-directory swap.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { ConversationSnapshot, SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationRoot, DetailsPanel, EmptyState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SelectionTarget, ViewEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'

afterEach(cleanup)

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [],
    pending: [], running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, lastAgentError: null,
  } as ConversationSnapshot
}

function sessionSource(over?: Partial<ConversationSnapshot>) {
  const snap = { ...snapshotBase(), ...over }
  return {
    getSnapshot: () => snap,
    subscribe: () => () => {},
  }
}

const summary = (id: string, title: string): SessionSummary =>
  ({ id: id as SessionId, title, running: false, updatedAt: 1 })

describe('ConversationRoot branches', () => {
  const chatEntry: ViewEntry = {
    id: 'chat', label: 'Chat', component: () => null,
  } as unknown as ViewEntry

  function rootProps(over?: {
    ancestry?: readonly SessionSummary[]
    snapshot?: Partial<ConversationSnapshot>
  }) {
    const open = vi.fn()
    const view = render(
      <ConversationRoot
        sessionId={SID}
        useSession={bindSnapshotSelector(sessionSource(over?.snapshot)) as unknown as UseSession}
        useAncestry={() => over?.ancestry ?? []}
        views={{ list: () => [chatEntry], subscribe: () => () => {}, version: () => 1 }}
        useActiveView={() => undefined}
        composer={{ useDraft: () => '', setDraft: vi.fn(), send: vi.fn(), stop: vi.fn() }}
        actions={{ openView: vi.fn(), open }}
        renderView={() => <div data-testid="view-body" />}
      />,
    )
    return { view, open }
  }

  it('renders the ancestry breadcrumb with separators and navigates on ancestor click', () => {
    const { view, open } = rootProps({
      ancestry: [summary('root-1', 'Workspace'), summary('s1', 'Current')],
    })
    expect(view.getByText('Workspace')).toBeTruthy()
    expect(view.getByText('/')).toBeTruthy()
    fireEvent.click(view.getByText('Workspace'))
    expect(open).toHaveBeenCalledWith('root-1' as SessionId)
    // The last crumb is the current session: disabled, no navigation.
    fireEvent.click(view.getByText('Current'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('falls back to the raw session id without ancestry and counts user turns', () => {
    const { view } = rootProps({
      snapshot: { nodes: [{ kind: 'user', seq: 1 } as never, { kind: 'assistant', seq: 2 } as never] },
    })
    expect(view.getByText(SID)).toBeTruthy()
    expect(view.getByText(/1 turns/)).toBeTruthy()
  })

  it('surfaces promptError through the composer error strip', () => {
    const { view } = rootProps({
      snapshot: { promptError: { op: 'stop', error: { message: 'halt', code: 'internal' } } as never },
    })
    expect(view.getByText(/停止失败：halt（internal）/)).toBeTruthy()
  })

  it('an unknown active view id falls back to the first registered view', () => {
    const view = render(
      <ConversationRoot
        sessionId={SID}
        useSession={bindSnapshotSelector(sessionSource()) as unknown as UseSession}
        useAncestry={() => []}
        views={{ list: () => [chatEntry], subscribe: () => () => {}, version: () => 1 }}
        useActiveView={() => 'gone' as never}
        composer={{ useDraft: () => '', setDraft: vi.fn(), send: vi.fn(), stop: vi.fn() }}
        actions={{ openView: vi.fn(), open: vi.fn() }}
        renderView={(entry) => <div data-testid={`body-${entry.id}`} />}
      />,
    )
    expect(view.getByTestId('body-chat')).toBeTruthy()
  })
})

describe('DetailsPanel branches', () => {
  function panel(selection: SelectionTarget | null, snapshot?: Partial<ConversationSnapshot>) {
    return render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector(sessionSource(snapshot)) as unknown as UseSession}
        useSelection={bindSnapshotSelector({ getSnapshot: () => selection, subscribe: () => () => {} })}
        actions={{ closeDetails: vi.fn() }}
      />,
    )
  }

  it('shows non-JSON args verbatim (streaming fragment path)', () => {
    const view = panel({ turnSeq: 1, callId: 'c1', toolName: 'bash' }, {
      runningCalls: [{ callId: 'c1', name: 'bash', argsRaw: '{"cmd": tru', turn: 1, step: 1, callView: null }],
    })
    expect(view.getByText('{"cmd": tru')).toBeTruthy()
  })

  it('a selection without callId renders the empty hint (selector null arm)', () => {
    const view = panel({ turnSeq: 2 })
    expect(view.getByText(/点击消息流中的工具行查看详情/)).toBeTruthy()
  })

  it('snapshot updates re-run the material selector through the shallow equality arm', () => {
    let snap = { ...snapshotBase(), runningCalls: [{ callId: 'c9', name: 'bash', argsRaw: '{"a":1}', turn: 1, step: 1, callView: null }] } as ConversationSnapshot
    const subs = new Set<() => void>()
    const source = {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    }
    const SEL: SelectionTarget = { turnSeq: 1, callId: 'c9' }
    const view = render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector(source) as unknown as UseSession}
        useSelection={bindSnapshotSelector({ getSnapshot: () => SEL, subscribe: () => () => {} })}
        actions={{ closeDetails: vi.fn() }}
      />,
    )
    expect(view.getByText(/"a": 1/)).toBeTruthy()
    // Top-level swap with identical material members: the eq arm short-circuits.
    snap = { ...snap }
    for (const fn of [...subs]) fn()
    expect(view.getByText(/"a": 1/)).toBeTruthy()
  })

  it('windowless call material: no name/args fallback to callId, mixed node walk skips non-matches', () => {
    // A tool-result whose call head fell outside the window (call === null),
    // preceded by non-matching nodes so the walk exercises both filter arms.
    const view = panel({ turnSeq: 1, callId: 'c8' }, {
      nodes: [
        { kind: 'user', seq: 1, content: [], source: null } as never,
        { kind: 'tool-result', seq: 2, callId: 'other', call: { name: 'x', argsRaw: '{}' }, content: [], isError: false, callView: null, resultView: null } as never,
        { kind: 'tool-result', seq: 3, callId: 'c8', call: null, content: [], isError: false, callView: null, resultView: null } as never,
      ],
    })
    expect(view.getByText('c8')).toBeTruthy()
  })

  it('stringifies non-text result blocks and renders error-only results', () => {
    const withBlocks = panel({ turnSeq: 1, callId: 'c2' }, {
      nodes: [{
        kind: 'tool-result', seq: 3, callId: 'c2', call: { name: 'read', argsRaw: '{}' },
        content: [{ type: 'image', data: 'x' } as never],
        isError: false, callView: null, resultView: null,
      } as never],
    })
    expect(withBlocks.getByText(/"type": "image"/)).toBeTruthy()
    const errorOnly = panel({ turnSeq: 1, callId: 'c3' }, {
      nodes: [{
        kind: 'tool-result', seq: 4, callId: 'c3', call: { name: 'bash', argsRaw: '{}' },
        content: [], isError: true, error: { name: 'ToolError', code: 'timeout' },
        callView: null, resultView: null,
      } as never],
    })
    expect(errorOnly.getByText(/ToolError: timeout/)).toBeTruthy()
  })
})

describe('EmptyState branches', () => {
  // getSnapshot must return a stable reference (uSES contract) — a fresh
  // array per call loops the selector forever.
  const CWDS: readonly string[] = ['/proj']
  const NO_CWDS: readonly string[] = []

  it('keeps the draft and surfaces a local error strip when startSession rejects', async () => {
    const startSession = vi.fn(() => Promise.reject(new Error('create down')))
    const view = render(
      <EmptyState
        useCwds={bindSnapshotSelector({ getSnapshot: () => CWDS, subscribe: () => () => {} })}
        actions={{ startSession }}
      />,
    )
    const textarea = view.container.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'first task' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(view.getByText(/发送失败：create down/)).toBeTruthy())
    expect((textarea as HTMLTextAreaElement).value).toBe('first task')
  })

  it('non-Error rejection reasons stringify into the error strip', async () => {
    const startSession = vi.fn(() => Promise.reject('plain-string'))
    const view = render(
      <EmptyState
        useCwds={bindSnapshotSelector({ getSnapshot: () => NO_CWDS, subscribe: () => () => {} })}
        actions={{ startSession }}
      />,
    )
    const textarea = view.container.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'go' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(view.getByText(/发送失败：plain-string/)).toBeTruthy())
  })

  it('cwd select picks an option, swaps to free-form on 新目录, and submits the typed path', async () => {
    const startSession = vi.fn(() => Promise.resolve())
    const view = render(
      <EmptyState
        useCwds={bindSnapshotSelector({ getSnapshot: () => CWDS, subscribe: () => () => {} })}
        actions={{ startSession }}
      />,
    )
    const select = view.container.querySelector('select')!
    fireEvent.change(select, { target: { value: '/proj' } })
    expect((select as HTMLSelectElement).value).toBe('/proj')
    fireEvent.change(select, { target: { value: '::new-directory' } })
    const custom = view.container.querySelector('input')!
    fireEvent.change(custom, { target: { value: '/typed/dir' } })
    const textarea = view.container.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'task' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(startSession).toHaveBeenCalledWith({ text: 'task', mode: 'queue', cwd: '/typed/dir' }))
  })
})
