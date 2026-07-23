// @vitest-environment jsdom
// Skeleton branch tails for the coverage gate (complements skeleton.spec.tsx
// acceptance flows), four-share props form: breadcrumb ancestry derivation +
// error strip in ConversationRoot, DetailsPanel non-JSON args / non-text
// result blocks / error-only results over the shared store, EmptyState
// failure surface and custom-directory swap with in-component cwd derivation.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { hookOf } from './hook.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SelectionTarget, ViewEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Export discipline: packages/client/AGENTS.md.
import { createChatStore } from '../src/client/stores.ts'
import { ConversationRoot } from '../src/client/skeleton/ConversationRoot.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import { EmptyState } from '../src/client/skeleton/EmptyState.tsx'

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

/** Sessions-list stub over a snapshot store (the standard useSessions hook shape). */
function listHook(rows: { id: string; title: string; cwd?: string; parentId?: string }[]) {
  const store = createSnapshotStore<SessionListState>({
    ids: rows.map(r => r.id as SessionId),
    byId: Object.fromEntries(rows.map(r => [r.id, {
      id: r.id as SessionId, title: r.title, running: false, updatedAt: 1,
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.parentId !== undefined ? { parentId: r.parentId as SessionId } : {}),
    }])),
    current: undefined,
  } as SessionListState)
  return hookOf(store)
}

describe('ConversationRoot branches', () => {
  const chatEntry: ViewEntry = {
    id: 'chat', label: 'Chat', component: () => <div data-testid="view-body" />,
  } as unknown as ViewEntry

  function rootProps(over?: {
    rows?: { id: string; title: string; parentId?: string }[]
    snapshot?: Partial<ConversationSnapshot>
  }) {
    const open = vi.fn()
    const chat = createChatStore().create()
    const view = render(
      <ConversationRoot
        sessionId={SID}
        useSession={hookOf(sessionSource(over?.snapshot)) as unknown as UseSession<ConversationSnapshot>}
        useSessions={listHook(over?.rows ?? [])}
        useStore={hookOf(chat)}
        actions={chat.actions}
        views={{ list: () => [chatEntry], subscribe: () => () => {}, version: () => 1 }}
        send={vi.fn()}
        stop={vi.fn()}
        openDetails={vi.fn()}
        loadOlder={vi.fn()}
        open={open}
      />,
    )
    return { view, open, chat }
  }

  it('derives the ancestry breadcrumb from the sessions list and navigates on ancestor click', () => {
    const { view, open } = rootProps({
      rows: [{ id: 'root-1', title: 'Workspace' }, { id: 's1', title: 'Current', parentId: 'root-1' }],
    })
    expect(view.getByText('Workspace')).toBeTruthy()
    expect(view.getByText('/')).toBeTruthy()
    fireEvent.click(view.getByText('Workspace'))
    expect(open).toHaveBeenCalledWith('root-1' as SessionId)
    // The last crumb is the current session: disabled, no navigation.
    fireEvent.click(view.getByText('Current'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a broken parent link stops the ancestry walk at the known chain', () => {
    const { view } = rootProps({
      rows: [{ id: 's1', title: 'Orphan', parentId: 'vanished' }],
    })
    // The walk keeps s1 itself and stops where the parent is unknown.
    expect(view.getByText('Orphan')).toBeTruthy()
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

  it('an unknown stored view id falls back to the first registered view', () => {
    const { chat } = rootProps({})
    cleanup()
    chat.actions.setView('gone' as never)
    const view = render(
      <ConversationRoot
        sessionId={SID}
        useSession={hookOf(sessionSource()) as unknown as UseSession<ConversationSnapshot>}
        useSessions={listHook([])}
        useStore={hookOf(chat)}
        actions={chat.actions}
        views={{ list: () => [chatEntry], subscribe: () => () => {}, version: () => 1 }}
        send={vi.fn()}
        stop={vi.fn()}
        openDetails={vi.fn()}
        loadOlder={vi.fn()}
        open={vi.fn()}
      />,
    )
    expect(view.getByTestId('view-body')).toBeTruthy()
  })
})

describe('DetailsPanel branches', () => {
  function panel(selection: SelectionTarget | null, snapshot?: Partial<ConversationSnapshot>) {
    const chat = createChatStore().create()
    if (selection !== null) chat.actions.select(selection)
    return render(
      <DetailsPanel
        sessionId={SID}
        useSession={hookOf(sessionSource(snapshot)) as unknown as UseSession<ConversationSnapshot>}
        useSessions={listHook([])}
        useStore={hookOf(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
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
    const chat = createChatStore().create()
    chat.actions.select({ turnSeq: 1, callId: 'c9' })
    const view = render(
      <DetailsPanel
        sessionId={SID}
        useSession={hookOf(source) as unknown as UseSession<ConversationSnapshot>}
        useSessions={listHook([])}
        useStore={hookOf(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
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
  it('keeps the draft and surfaces a local error strip when startSession rejects', async () => {
    const startSession = vi.fn(() => Promise.reject(new Error('create down')))
    const view = render(
      <EmptyState useSessions={listHook([{ id: 'a', title: 'a', cwd: '/proj' }])} startSession={startSession} />,
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
      <EmptyState useSessions={listHook([])} startSession={startSession} />,
    )
    const textarea = view.container.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'go' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(view.getByText(/发送失败：plain-string/)).toBeTruthy())
  })

  it('cwd derivation skips blank cwds; select picks, swaps to free-form, submits the typed path', async () => {
    const startSession = vi.fn(() => Promise.resolve())
    const view = render(
      <EmptyState
        useSessions={listHook([
          { id: 'a', title: 'a', cwd: '/proj' },
          { id: 'b', title: 'b' }, // no cwd: filtered from the option set
        ])}
        startSession={startSession}
      />,
    )
    const select = view.container.querySelector('select')!
    expect([...(select as HTMLSelectElement).options].map(o => o.value))
      .toEqual(['', '/proj', '::new-directory'])
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
