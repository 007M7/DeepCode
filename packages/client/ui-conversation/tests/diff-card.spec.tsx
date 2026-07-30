// @vitest-environment jsdom
// The diff render intent on the web side: the pure diffCardModel derivation
// over callView/resultView, and both conversation render sites that consume it
// — the chat tool row's expanded body (GenericToolCard / FileMutationRow) and
// the details panel's Output section.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, RunningToolCall, SessionId, SessionListState, ToolResultNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-client-connection/client'
import type { SelectionTarget, ToolRowOwnerProps, ToolRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_DIFF_MAX_LINES, diffCardModel } from '../src/client/contract/diff-card-model.ts'
import { createChatStore } from '../src/client/stores.ts'
import { GenericToolCard } from '../src/client/chat/GenericToolCard.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import { FileMutationRow } from '../src/client/toolviews/file-mutation-row.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId

const ARGS = '{"file_path":"notes/demo.txt","old_string":"hello","new_string":"hello fixture"}'

/** The edit tool's own call view (a call-time diff derived from the arguments). */
const callDiff = (over?: Partial<Extract<ToolCallView, { card: 'diff' }>>): ToolCallView => ({
  card: 'diff', title: 'Edit notes/demo.txt',
  diffs: [{ path: 'notes/demo.txt', oldText: 'hello', newText: 'hello fixture' }], ...over,
})

/** The edit tool's own result view (the applied hunk diff). */
const resultDiff = (over?: Partial<Extract<ToolResultView, { card: 'diff' }>>): ToolResultView => ({
  card: 'diff', title: 'Edit notes/demo.txt',
  diffs: [{ path: 'notes/demo.txt', oldText: 'hello', newText: 'hello fixture' }], ...over,
})

const running = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'edit', argsRaw: ARGS,
  turn: 1, step: 1, time: 1_000, callView: callDiff(), ...over,
})

const settled = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'edit', argsRaw: ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'The file notes/demo.txt has been updated successfully.' }], isError: false,
  callView: callDiff(), resultView: resultDiff(), ...over,
})

describe('diffCardModel', () => {
  it('derives a running card from the call view alone', () => {
    expect(diffCardModel(running())).toEqual({
      card: { diffs: [{ path: 'notes/demo.txt', oldText: 'hello', newText: 'hello fixture' }] },
    })
  })

  it('derives a settled card from the result view, which replaces the call-time diff', () => {
    // The applied hunks (result) win over the args-derived call diff.
    expect(diffCardModel(settled({
      resultView: resultDiff({ diffs: [{ path: 'notes/demo.txt', oldText: 'a', newText: 'b' }] }),
    }))).toEqual({
      card: { diffs: [{ path: 'notes/demo.txt', oldText: 'a', newText: 'b' }] },
    })
  })

  it('renders a settled diff even when the window dropped the call head', () => {
    // A truncated call carries only the result view, which holds the whole change.
    expect(diffCardModel(settled({ call: null, callView: null }))?.card.diffs).toHaveLength(1)
  })

  it('returns null for every non-diff call: no views, generic views, unknown cards', () => {
    expect(diffCardModel(running({ callView: null }))).toBeNull()
    expect(diffCardModel(settled({ callView: null, resultView: null }))).toBeNull()
    expect(diffCardModel(running({ callView: { card: 'generic', title: 'read x' } }))).toBeNull()
    // A generic result settles a diff call on the generic path (write/edit's
    // own execution-error arm).
    expect(diffCardModel(settled({ resultView: { card: 'generic' } }))).toBeNull()
    // A card tag this UI version does not know arrives over the wire; the
    // documented generic-card default takes it, not a crash.
    const future = { card: 'chart', title: 'plot' } as unknown as ToolCallView
    expect(diffCardModel(running({ callView: future }))).toBeNull()
    expect(diffCardModel(settled({
      callView: future, resultView: { card: 'chart' } as unknown as ToolResultView,
    }))).toBeNull()
  })
})

describe('chat row diff body', () => {
  const ownerProps = (block: RunningToolCall | ToolResultNode): ToolRowOwnerProps => ({
    callId: 'c1', toolName: 'edit', block, openFile: vi.fn(),
  })

  it('the expanded body is the applied diff, capped tighter than the panel', () => {
    expect(CHAT_DIFF_MAX_LINES).toBeLessThan(16)
    const view = render(<GenericToolCard {...ownerProps(settled())} />)
    // Collapsed: the summary row (path) only, no diff body.
    expect(view.queryByText('hello fixture')).toBeNull()
    // The path link is not the expand control; the leading toggle is.
    fireEvent.click(view.container.querySelector('button[aria-expanded]')!)
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(view.getByText('hello fixture')).toBeTruthy()
  })

  it('a running diff call expands to its intended change', () => {
    const view = render(<GenericToolCard {...ownerProps(running())} />)
    fireEvent.click(view.container.querySelector('button[aria-expanded]')!)
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
  })

  it('a non-diff call keeps the args-JSON text body', () => {
    // A non-file tool name so the row is not single-file (no path link), and its
    // args body is the fallback the diff card must not have replaced.
    const view = render(<GenericToolCard {...{
      callId: 'c1', toolName: 'some_tool', openFile: vi.fn(),
      block: settled({
        call: { name: 'some_tool', argsRaw: '{"foo":"bar"}' },
        callView: null, resultView: null,
      }),
    }} />)
    fireEvent.click(view.container.querySelector('button[aria-expanded]')!)
    expect(view.container.querySelector('[data-diff]')).toBeNull()
    expect(view.getByText(/"foo"/)).toBeTruthy()
  })
})

describe('FileMutationRow diff card', () => {
  const list = () => createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, waitingApproval: false, updatedAt: 0, cwd: '/w/app' } },
    current: SID,
    phase: 'ready',
  })

  const rowProps = (block: RunningToolCall | ToolResultNode, toolName = 'edit'): ToolRowProps => ({
    callId: 'c1', toolName, block, openFile: vi.fn(), cwd: '/w/app',
    sessionId: SID, useSessions: bindSnapshotSelector(list()),
  } as unknown as ToolRowProps)

  it('renders the applied diff under the summary row, without an expand gesture', () => {
    const view = render(<FileMutationRow {...rowProps(settled())} />)
    // The diff card is resident (no expand toggle needed).
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(view.getByText('hello fixture')).toBeTruthy()
    expect(view.getByText('复制')).toBeTruthy()
  })

  it('the summary is a path link that opens through the host, cwd-resolved', () => {
    const openFile = vi.fn()
    const view = render(<FileMutationRow {...{ ...rowProps(settled()), openFile }} />)
    fireEvent.click(view.getByRole('button', { name: 'notes/demo.txt' }))
    expect(openFile).toHaveBeenCalledWith('/w/app/notes/demo.txt')
  })

  it('registers under write too, rendering a create as an added-only diff', () => {
    const writeArgs = '{"file_path":"notes/new.txt","content":"hello fixture\\n"}'
    const view = render(<FileMutationRow {...rowProps(settled({
      call: { name: 'write', argsRaw: writeArgs },
      callView: { card: 'diff', title: 'Write notes/new.txt', diffs: [{ path: 'notes/new.txt', oldText: null, newText: 'hello fixture' }] },
      resultView: { card: 'diff', title: 'Write notes/new.txt', diffs: [{ path: 'notes/new.txt', oldText: null, newText: 'hello fixture' }] },
    }), 'write')} />)
    expect(view.getByText('└ +1 -0 · 1 file')).toBeTruthy()
  })

  it('reflects the run state on its leading slot', () => {
    const runningView = render(<FileMutationRow {...rowProps(running())} />)
    expect(runningView.container.querySelector('[data-state="running"]')).not.toBeNull()
    cleanup()
    const errorView = render(<FileMutationRow {...rowProps(settled({ isError: true, resultView: null, callView: null }))} />)
    expect(errorView.container.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('a mutation call with no diff view renders the summary row alone', () => {
    const view = render(<FileMutationRow {...rowProps(settled({ callView: null, resultView: null }))} />)
    expect(view.container.querySelector('[data-diff]')).toBeNull()
  })
})

describe('DetailsPanel diff Output section', () => {
  function mount(snapshot: ConversationSnapshot, selection: SelectionTarget | null, cwd?: string) {
    localStorage.clear()
    const chat = createChatStore().create()
    if (selection !== null) chat.actions.select(selection)
    const sessions = createSnapshotStore<SessionListState>(cwd === undefined
      ? { ids: [], byId: {}, current: undefined, phase: 'ready' }
      : {
        ids: [SID],
        byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, waitingApproval: false, updatedAt: 0, cwd } },
        current: SID,
        phase: 'ready',
      })
    const workspaces = createSnapshotStore<WorkspaceListState>({
      items: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })
    return render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector({ getSnapshot: () => snapshot, subscribe: () => () => {} })}
        useSessions={bindSnapshotSelector(sessions)}
        useWorkspaces={bindSnapshotSelector(workspaces)}
        useInput={(() => { throw new Error('unused') })}
        inputActions={{ setDraft: () => {}, submit: () => {} }}
        useProjection={(() => undefined)}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
      />,
    )
  }

  function snapshot(over: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
    return {
      sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
      pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
      openState: 'open', openError: null, hasMore: false, loadingOlder: false,
      promptError: null, blank: false, lastAgentError: null, ...over,
    }
  }

  const target: SelectionTarget = { turnSeq: 10, callId: 'c1', toolName: 'edit' }

  it('renders the applied diff at full height, keeping the JSON Input section', () => {
    const view = mount(snapshot({ nodes: [settled()] }), target)
    expect(view.getByText(/"file_path"/)).toBeTruthy()
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(view.getByText('hello fixture')).toBeTruthy()
  })

  it('a running diff call renders its intended change, not the 运行中… placeholder', () => {
    const view = mount(snapshot({ runningCalls: [running()] }), target)
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(view.queryByText('运行中…')).toBeNull()
  })

  it('a non-diff result keeps the flattened pre', () => {
    const view = mount(snapshot({
      nodes: [settled({
        callView: null, resultView: null,
        content: [{ type: 'text', text: 'permission denied' }],
      })],
    }), target)
    expect(view.container.querySelector('[data-diff]')).toBeNull()
    expect(view.getByText('Output').closest('section')?.querySelector('pre')?.textContent).toBe('permission denied')
  })
})
