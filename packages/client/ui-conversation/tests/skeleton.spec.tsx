// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { EmptyStateProps } from '../src/client/skeleton/EmptyState.tsx'
import type { ConversationRootProps } from '../src/client/skeleton/ConversationRoot.tsx'
import { createChatStore } from '../src/client/stores.ts'
import { ConversationRoot } from '../src/client/skeleton/ConversationRoot.tsx'
import { EmptyState } from '../src/client/skeleton/EmptyState.tsx'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const SID = sid('s1')

function workspace(id = 'w1'): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title: id, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

type SessionIntent = NonNullable<SessionListState['intent']>
type WorkspaceIntent = NonNullable<WorkspaceListState['intent']>

const workspaceState = (
  items: readonly WorkspaceView[], workspaceIntent?: WorkspaceIntent,
): WorkspaceListState => ({
  items, intent: workspaceIntent, state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: undefined,
})
const hook = <T,>(snapshot: T) => <S,>(selector: (state: T) => S): S => selector(snapshot)

function mountEmpty(
  intent: SessionIntent,
  items: readonly WorkspaceView[] = [],
  localWorkspace?: WorkspaceIntent,
) {
  const updateSessionPrompt = vi.fn()
  const sendSession = vi.fn()
  const startSession = vi.fn()
  let pickerOwner: unknown
  const sessionState: SessionListState = {
    ids: [], byId: {}, current: intent.sessionId, intent, phase: 'ready',
  }
  const workspaceIntent = intent.target.kind === 'workspace-intent'
    ? localWorkspace ?? { name: 'workspace', phase: 'ready' as const }
    : undefined
  const view = render(
    <EmptyState
      useSessions={hook(sessionState)}
      useWorkspaces={hook(workspaceState(items, workspaceIntent))}
      updateSessionPrompt={updateSessionPrompt}
      sendSession={sendSession}
      startSession={startSession}
      renderSlot={((_key: string, owner: unknown) => { pickerOwner = owner; return null }) as EmptyStateProps['renderSlot']}
    />,
  )
  return { view, updateSessionPrompt, sendSession, startSession, pickerOwner: () => pickerOwner }
}

describe('EmptyState', () => {
  it('reads the Workspace and Session intents from runtime projections', () => {
    const b = mountEmpty({
      sessionId: sid('local-1'), target: { kind: 'workspace-intent' },
      prompt: 'draft', phase: 'ready',
    })
    expect(b.view.getByRole('button', { name: 'Choose workspace' }).textContent).toContain('workspace')
    fireEvent.click(b.view.getByRole('button', { name: 'Add attachment' }))
    expect((b.pickerOwner() as { open: boolean }).open).toBe(false)
    fireEvent.change(b.view.getByPlaceholderText('Describe what you want to build'), { target: { value: 'build it' } })
    expect(b.updateSessionPrompt).toHaveBeenCalledWith('build it')
    fireEvent.click(b.view.getByRole('button', { name: 'Send message' }))
    expect(b.sendSession).toHaveBeenCalledOnce()
  })

  it('uses useWorkspaces for the selected label and preserves the prompt when retargeting', () => {
    const first = workspace('first')
    const b = mountEmpty({
      sessionId: sid('local-2'), target: { kind: 'workspace', workspaceId: first.workspaceId },
      prompt: 'keep me', phase: 'ready',
    }, [first])
    expect(b.view.getByRole('button', { name: 'Choose workspace' }).textContent).toContain('first')
    fireEvent.click(b.view.getByRole('button', { name: 'Choose workspace' }))
    const owner = b.pickerOwner() as { onPick(id: WorkspaceId): void }
    owner.onPick(wid('second'))
    expect(b.startSession).toHaveBeenCalledWith(wid('second'), 'keep me')
  })

  it('exposes materialization phase and failure text', () => {
    const creating = mountEmpty({
      sessionId: sid('local-3'), target: { kind: 'workspace-intent' },
      prompt: 'x', phase: 'ready',
    }, [], { name: 'workspace', phase: 'creating' })
    expect(creating.view.getByRole('status').textContent).toBe('Creating workspace…')
    cleanup()
    const workspaceFailed = mountEmpty({
      sessionId: sid('local-3'), target: { kind: 'workspace-intent' },
      prompt: 'x', phase: 'ready',
    }, [], { name: 'workspace', phase: 'ready', error: 'offline' })
    expect(workspaceFailed.view.getByRole('alert').textContent).toBe('Workspace creation failed: offline')
    cleanup()
    const failed = mountEmpty({
      sessionId: sid('local-3'), target: { kind: 'workspace', workspaceId: wid('w1') },
      prompt: 'x', phase: 'ready', error: { step: 'session', message: 'offline' },
    }, [workspace()])
    expect(failed.view.getByRole('alert').textContent).toBe('Session creation failed: offline')
  })
})

function conversationSnapshot(
  composerPhase: ConversationSnapshot['composerPhase'],
  pendingPrompt: ConversationSnapshot['pendingPrompt'] = null,
): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], running: false, composerPhase, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, intent: null, pendingPrompt, lastAgentError: null,
  }
}

function mountConversation(pendingPrompt: ConversationSnapshot['pendingPrompt'] = null) {
  const root = sid('root')
  const sessions = createSnapshotStore<SessionListState>({
    ids: [root, SID],
    byId: {
      [root]: { id: root, displayTitle: 'Root', running: false, updatedAt: 1 },
      [SID]: { id: SID, displayTitle: 'Child', parentId: root, cwd: '/projects/one', running: false, updatedAt: 2 },
    },
    current: SID,
    intent: undefined,
    phase: 'ready',
  })
  const workspaces = createSnapshotStore<WorkspaceListState>(workspaceState([{ ...workspace('one'), sessionIds: [SID] }]))
  const session = createSnapshotStore<ConversationSnapshot>(conversationSnapshot(
    pendingPrompt === null ? 'active' : 'blank', pendingPrompt,
  ))
  const chat = createChatStore().create()
  chat.actions.setDraft('ordinary draft')
  const send = vi.fn()
  const stop = vi.fn()
  const open = vi.fn()
  const updateSessionPrompt = vi.fn()
  const retrySessionPrompt = vi.fn()
  const renderSlot = ((_key: string, _owner: object, opts?: { only?: string }) => (
    <div data-testid={`view-${opts?.only ?? 'all'}`} />
  )) as ConversationRootProps['renderSlot']
  const renderSlotChain = ((_key, _owner, opts) => opts?.fallback ?? null) as ConversationRootProps['renderSlotChain']
  const SessionProvider: ConversationRootProps['SessionProvider'] = ({ children }) => <>{children(SID)}</>
  const props: ConversationRootProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    renderSlot,
    renderSlotChain,
    SessionProvider,
    views: { list: () => [{ id: 'chat', label: 'Chat' }], subscribe: () => () => {}, version: () => 1 },
    send,
    stop,
    open,
    updateSessionPrompt,
    retrySessionPrompt,
  }
  const view = render(<ConversationRoot {...props} />)
  return { view, chat, send, open, updateSessionPrompt, retrySessionPrompt }
}

describe('ConversationRoot draft ownership', () => {
  it('keeps ordinary per-Session composer text in the chat store and selects through runtime actions', () => {
    const b = mountConversation()
    const box = b.view.getByRole('textbox')
    expect((box as HTMLTextAreaElement).value).toBe('ordinary draft')
    fireEvent.change(box, { target: { value: 'ordinary revised' } })
    expect(b.chat.store.getSnapshot().draft).toBe('ordinary revised')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.send).toHaveBeenCalledWith('ordinary revised', 'queue')
    fireEvent.click(b.view.getByRole('button', { name: 'Root' }))
    expect(b.open).toHaveBeenCalledWith(sid('root'))
  })

  it('reads a retained prompt from useSession and edits/retries it through the scoped Session', () => {
    const b = mountConversation({
      workspaceId: wid('one'), text: 'retry me', phase: 'failed',
      retry: 'send', error: 'offline',
    })
    const box = b.view.getByRole('textbox')
    expect((box as HTMLTextAreaElement).value).toBe('retry me')
    expect(b.view.getByRole('alert').textContent).toBe('Message send failed: offline')
    fireEvent.change(box, { target: { value: 'revised prompt' } })
    expect(b.updateSessionPrompt).toHaveBeenCalledWith('revised prompt')
    expect(b.chat.store.getSnapshot().draft).toBe('ordinary draft')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.retrySessionPrompt).toHaveBeenCalledOnce()
    expect(b.send).not.toHaveBeenCalled()
  })
})
