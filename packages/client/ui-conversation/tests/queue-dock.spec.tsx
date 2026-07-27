// @vitest-environment jsdom
/**
 * QueueDock rendering (web input-triggers queue cut 1): empty queue renders
 * nothing, rows render one preview line each keyed by rpcId, and the strip
 * follows queue changes through the useSession selector.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ConversationSnapshot, QueuedMessage, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputState } from '../src/client/input/contract.ts'
import { QueueDock, queueDockEntry } from '../src/client/queue/QueueDock.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId

function snapshotWith(queue: QueuedMessage[]): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue, running: true, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

/** Minimal live source backing the useSession stub (queue swaps notify subscribers). */
function liveSession(initial: ConversationSnapshot) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const useSession: SnapshotSelectorHook<ConversationSnapshot> = sel =>
    useSyncExternalStore(
      (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      () => sel(snapshot),
    )
  return {
    useSession,
    push(next: ConversationSnapshot): void {
      snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** InputZone owner stub (the dock reads useSession only; the zone fields satisfy the owner share). */
const INPUT_STATE: InputState = { draft: '', draftRev: 0, phase: 'plain', occurrences: [], queue: [] }

function kitFor(snapshot: ConversationSnapshot) {
  return {
    sessionId: SID,
    useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
    useWorkspaces: (() => { throw new Error('unused') }) as never,
    useProjection: (() => undefined) as never,
    useInput: (() => { throw new Error('unused') }) as never,
    inputActions: { setDraft: () => {}, submit: () => {} } as never,
    session: snapshot,
    input: INPUT_STATE,
  }
}

describe('QueueDock', () => {
  it('renders null while the queue is empty', () => {
    const snap = snapshotWith([])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders one preview row per queued message with the count strip', () => {
    const snap = snapshotWith([
      { key: 'p-1', preview: '第一条排队消息' },
      { key: 'p-2', preview: 'second queued line' },
    ])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.textContent).toContain('已排队 2 条')
    const rows = [...container.querySelectorAll('li')]
    expect(rows.map(r => r.textContent)).toEqual(['第一条排队消息', 'second queued line'])
  })

  it('follows queue changes: retirement empties the strip back to null', () => {
    const snap = snapshotWith([{ key: 'p-1', preview: '在场' }])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.textContent).toContain('在场')
    act(() => { source.push(snapshotWith([])) })
    expect(container.innerHTML).toBe('')
  })

  it('ships the registrant plugin shape (list entry into conversation.input.dock)', () => {
    // Registration itself runs under T5's slot declaration; here we pin the
    // frozen registration surface so the wiring layer can mount it verbatim.
    expect(queueDockEntry.name).toBe('conversation-queue-dock')
    expect(queueDockEntry.inject).toEqual(['slots', 'conversation'])
    expect(typeof queueDockEntry.apply).toBe('function')
  })
})
