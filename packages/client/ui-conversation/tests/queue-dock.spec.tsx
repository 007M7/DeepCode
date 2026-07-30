// @vitest-environment jsdom
/**
 * QueueDock rendering and operations: authoritative rows, inline editing,
 * removal, failure notices, and live retirement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type {
  ConversationSnapshot, QueuedMessage, SessionId, SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { QueueItemId } from '../src/client/contract/queue.ts'
import type { InputState } from '../src/client/input/contract.ts'
import { QueueDock, queueDockEntry, type QueueDockInjected } from '../src/client/queue/QueueDock.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId
const iid = (id: string): QueueItemId => id as QueueItemId

function row(id: string, text: string | null, preview = text ?? '[image]'): QueuedMessage {
  return { id: iid(id), preview, text }
}

function snapshotWith(queue: QueuedMessage[]): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue, running: true, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

/** Minimal live source backing the useSession stub. */
function liveSession(initial: ConversationSnapshot) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const useSession: SnapshotSelectorHook<ConversationSnapshot> = selector =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => selector(snapshot),
    )
  return {
    useSession,
    push(next: ConversationSnapshot): void {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const INPUT_STATE: InputState = { draft: '', draftRev: 0, phase: 'plain', occurrences: [], queue: [] }

function kitFor(snapshot: ConversationSnapshot, injected: Partial<QueueDockInjected> = {}) {
  return {
    sessionId: SID,
    useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
    useWorkspaces: (() => { throw new Error('unused') }) as never,
    useProjection: (() => undefined) as never,
    useInput: (() => { throw new Error('unused') }) as never,
    inputActions: { setDraft: () => {}, submit: () => {} } as never,
    session: snapshot,
    input: INPUT_STATE,
    updateQueue: vi.fn(() => Promise.resolve()),
    notify: vi.fn(),
    ...injected,
  }
}

describe('QueueDock', () => {
  it('renders null while the queue is empty', () => {
    const snap = snapshotWith([])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders active actions and disables editing for mixed-content rows', () => {
    const snap = snapshotWith([
      row('i-1', '第一条排队消息'),
      row('i-2', null, 'image [image]'),
    ])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect([...container.querySelectorAll('li')].map(item => item.textContent))
      .toEqual(['第一条排队消息', 'image [image]'])
    expect(container.querySelectorAll('button')).toHaveLength(4)
    expect(container.querySelectorAll('[aria-label="编辑排队消息"]')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-label="删除排队消息"]')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-label="立即发送排队消息"]')).toHaveLength(0)
    expect((container.querySelectorAll('[aria-label="编辑排队消息"]')[0] as HTMLButtonElement).disabled).toBe(false)
    expect((container.querySelectorAll('[aria-label="编辑排队消息"]')[1] as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelectorAll('[aria-label="编辑排队消息"]')[1]?.getAttribute('title'))
      .toBe('包含非文本内容，暂不支持编辑')
  })

  it('edits text inline with save and cancel controls, then saves with the same item identity', async () => {
    const snap = snapshotWith([row('i-edit', 'before')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getByLabelText, queryByLabelText } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('编辑排队消息'))
    const editor = getByLabelText('编辑排队消息') as HTMLInputElement
    expect(getByLabelText('保存排队消息')).toBeTruthy()
    expect(getByLabelText('取消编辑')).toBeTruthy()
    expect(queryByLabelText('删除排队消息')).toBeNull()
    fireEvent.change(editor, { target: { value: 'after' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => {
      expect(updateQueue).toHaveBeenCalledWith(iid('i-edit'), {
        kind: 'edit',
        content: [{ type: 'text', text: 'after' }],
      })
    })
  })

  it('cancels an edit by button or Escape without mutating the queue', () => {
    const snap = snapshotWith([row('i-edit', 'before')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getByLabelText, getByText } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('编辑排队消息'))
    fireEvent.change(getByLabelText('编辑排队消息'), { target: { value: 'abandoned' } })
    fireEvent.click(getByLabelText('取消编辑'))
    expect(getByText('before')).toBeTruthy()

    fireEvent.click(getByLabelText('编辑排队消息'))
    fireEvent.keyDown(getByLabelText('编辑排队消息'), { key: 'Escape' })
    expect(getByText('before')).toBeTruthy()
    expect(updateQueue).not.toHaveBeenCalled()
  })

  it('keeps editing during IME composition and disables a blank save', () => {
    const snap = snapshotWith([row('i-edit', 'before')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getByLabelText } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('编辑排队消息'))
    const editor = getByLabelText('编辑排队消息')
    fireEvent.change(editor, { target: { value: '   ' } })
    expect(getByLabelText('保存排队消息')).toHaveProperty('disabled', true)
    fireEvent.change(editor, { target: { value: '输入中' } })
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
    expect(updateQueue).not.toHaveBeenCalled()
    expect(getByLabelText('编辑排队消息')).toBeTruthy()
  })

  it('removes the addressed row', async () => {
    const snap = snapshotWith([row('i-1', 'one'), row('i-2', 'two')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getAllByLabelText } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getAllByLabelText('删除排队消息')[0]!)
    await waitFor(() => {
      expect(updateQueue).toHaveBeenCalledWith(iid('i-1'), { kind: 'remove' })
    })
  })

  it('keeps the row and surfaces a notice when an operation loses the claim race', async () => {
    const snap = snapshotWith([row('i-race', 'pending')])
    const source = liveSession(snap)
    const notify = vi.fn()
    const updateQueue = vi.fn(() => Promise.reject(new Error('not found')))
    const { getByLabelText, getByText } = render(
      <QueueDock {...kitFor(snap, { updateQueue, notify })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('删除排队消息'))
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('error', '删除失败：这条消息可能已经开始发送。')
    })
    expect(getByText('pending')).toBeTruthy()
  })

  it('follows authoritative retirement back to null', () => {
    const snap = snapshotWith([row('i-1', '在场')])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.textContent).toContain('在场')
    act(() => { source.push(snapshotWith([])) })
    expect(container.innerHTML).toBe('')
  })

  it('ships the session-scoped registrant plugin shape', () => {
    expect(queueDockEntry.name).toBe('conversation-queue-dock')
    expect(queueDockEntry.inject).toEqual(['slots', 'conversation', 'sessions'])
    expect(typeof queueDockEntry.apply).toBe('function')
  })
})
