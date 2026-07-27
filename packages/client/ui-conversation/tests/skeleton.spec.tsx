// @vitest-environment jsdom
// ConversationRoot skeleton behavior: the ONE resident composer across the
// hero (blank session) and active phases — same textarea DOM node, machine-
// owned draft, and the hero workspace picker (switching = retargetWorkspace).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationRootProps } from '../src/client/skeleton/ConversationRoot.tsx'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createChatStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { ConversationRoot } from '../src/client/skeleton/ConversationRoot.tsx'
import { ConversationSession } from '../src/client/skeleton/ConversationSession.tsx'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import type { ComposerBarOwnerProps } from '../src/client/contract/slots.ts'

/** Machine-backed wiring over a sink spy. */
function fakeWiring() {
  const sink = vi.fn()
  const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink })
  return { wiring: shell, sink, shell }
}

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

const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: undefined,
})

function conversationSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue: [], todos: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, lastAgentError: null,
    ...overrides,
  }
}

function mount(snapshot: ConversationSnapshot, workspaceRows: WorkspaceView[] = [{ ...workspace('one'), sessionIds: [SID] }]) {
  const root = sid('root')
  const sessions = createSnapshotStore<SessionListState>({
    ids: [root, SID],
    byId: {
      [root]: { id: root, displayTitle: 'Root', running: false, blank: false, updatedAt: 1 },
      [SID]: { id: SID, displayTitle: 'Child', parentId: root, cwd: '/projects/one', running: false, blank: false, updatedAt: 2 },
    },
    current: SID,
    phase: 'ready',
  })
  const workspaces = createSnapshotStore<WorkspaceListState>(workspaceState(workspaceRows))
  const session = createSnapshotStore<ConversationSnapshot>(snapshot)
  const useSession = bindSnapshotSelector(session)
  const chat = createChatStore().create()
  chat.actions.setDraft('ordinary draft')
  const { wiring, sink } = fakeWiring()
  const useInput = bindSnapshotSelector(wiring.state)
  const inputActions = wiring.actions
  const stop = vi.fn()
  const open = vi.fn()
  const retargetWorkspace = vi.fn()
  const slotCalls: string[] = []
  let pickerOwner: unknown
  const renderSlot = ((key: string, owner: object, opts?: { only?: string }) => {
    slotCalls.push(key)
    if (key === 'conversation.hero.workspace') { pickerOwner = owner; return null }
    if (key === 'conversation.session') {
      return (
        <ConversationSession
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useInput={useInput}
          inputActions={inputActions}
          useStore={bindSnapshotSelector(chat)}
          actions={chat.actions}
          renderSlot={renderSlot as never}
          views={{ list: () => [{ id: 'chat', label: 'Chat' }], subscribe: () => () => {}, version: () => 1 }}
          bindDraftMirror={write => wiring.bindMirror(write)}
          open={open}
        />
      )
    }
    if (key === 'conversation.composer.bar') {
      // The real entry, mounted the way the outlet composes it: standard kit
      // (shared with the root's props below) + this entry's inject + owner.
      const bar = owner as ComposerBarOwnerProps
      return (
        <InputBar
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useInput={useInput}
          inputActions={inputActions}
          keyboard={wiring}
          stop={stop}
          renderSlot={(() => null) as InputBarProps['renderSlot']}
          {...bar}
        />
      )
    }
    return <div data-testid={`view-${opts?.only ?? key}`} />
  }) as ConversationRootProps['renderSlot']
  const renderSlotChain = ((_key, _owner, opts) => opts?.fallback ?? null) as ConversationRootProps['renderSlotChain']
  const props: ConversationRootProps = {
    sessionId: SID,
    SessionProvider: ({ children }) => children(SID),
    useSession,
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useInput,
    inputActions,
    renderSlot,
    renderSlotChain,
    selectWorkspace: retargetWorkspace,
  }
  const view = render(<ConversationRoot {...props} />)
  return {
    view, chat, sink, open, retargetWorkspace, session, slotCalls,
    pickerOwner: () => pickerOwner,
    rerender: () => { view.rerender(<ConversationRoot {...props} />) },
  }
}

describe('ConversationRoot resident composer', () => {
  it('keeps composer text in the machine, mirrors to the chat store, and submits through the sink', () => {
    const b = mount(conversationSnapshot())
    const box = b.view.getByRole('textbox')
    expect((box as HTMLTextAreaElement).value).toBe('ordinary draft')
    fireEvent.change(box, { target: { value: 'ordinary revised' } })
    expect(b.chat.store.getSnapshot().draft).toBe('ordinary revised')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.sink).toHaveBeenCalledWith('ordinary revised', 'queue')
    fireEvent.click(b.view.getByRole('button', { name: 'Root' }))
    expect(b.open).toHaveBeenCalledWith(sid('root'))
  })

  it('hero phase: same textarea, hero chrome, no header, picker switches the workspace', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true }))
    // Hero chrome present, view ring absent.
    expect(b.view.getByText("Let's start building")).toBeTruthy()
    expect(b.view.queryByTestId('view-chat')).toBeNull()
    // The same machine-backed textarea is live in the hero, and the
    // persistence mirror stays bound (ConversationSession mounts chrome-less
    // for blank sessions): hero typing reaches the chat store.
    const box = b.view.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'draft in hero' } })
    expect(b.chat.store.getSnapshot().draft).toBe('draft in hero')
    // Picker: open through the chip; a pick switches to the other
    // workspace's blank session (draft carry is apply-layer wiring).
    fireEvent.click(b.view.getByRole('button', { name: 'Choose workspace' }))
    const owner = b.pickerOwner() as { open: boolean; onPick(id: WorkspaceId): void }
    expect(owner.open).toBe(true)
    owner.onPick(wid('second'))
    expect(b.retargetWorkspace).toHaveBeenCalledWith(wid('second'))
  })

  it('textarea DOM identity survives the hero → active flip', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true }))
    const before = b.view.getByRole('textbox')
    fireEvent.change(before, { target: { value: 'kept across flip' } })
    // First message landed: content exists, phase leaves blank.
    b.session.set(conversationSnapshot({ composerPhase: 'active', blank: false }))
    b.rerender()
    const after = b.view.getByRole('textbox')
    expect(after).toBe(before)
    expect((after as HTMLTextAreaElement).value).toBe('kept across flip')
    expect(b.view.queryByText("Let's start building")).toBeNull()
    expect(b.view.getByTestId('view-chat')).toBeTruthy()
  })

  it('blank session keeps the interactive picker chip (workspace switchable until the first message)', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true }))
    const chip = b.view.getByRole('button', { name: 'Choose workspace' })
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    expect(b.slotCalls).toContain('conversation.hero.workspace')
  })

  it('prompt failure renders the promptError strip (ordinary failure, no transaction UI)', () => {
    const b = mount(conversationSnapshot({
      promptError: { op: 'send', error: { code: 'offline', message: 'Message send failed' } as never },
    }))
    expect(b.view.getByRole('alert').textContent).toContain('Message send failed (offline)')
    expect(b.view.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
