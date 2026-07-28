// @vitest-environment jsdom
// The terminal render intent on the web side: the pure terminalCardModel
// derivation over callView/resultView, and both conversation render sites that
// consume it — the chat tool row's expanded body (GenericToolCard / BashRow)
// and the details panel's Output section.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, RunningToolCall, SessionId, SessionListState, ToolResultNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-client-connection/client'
import type { SelectionTarget, ToolRowOwnerProps, ToolRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_TERMINAL_MAX_LINES, terminalCardModel } from '../src/client/contract/terminal-card-model.ts'
import { createChatStore } from '../src/client/stores.ts'
import { GenericToolCard } from '../src/client/chat/GenericToolCard.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import { BashRow } from '../src/client/toolviews/bash-sample.tsx'

afterEach(cleanup)

/**
 * Match an output line with its interior whitespace intact: the column
 * alignment this card exists to preserve is exactly what the default
 * whitespace-collapsing matcher would hide.
 */
const RAW = { normalizer: (text: string) => text }

/** The rendered card's run-state dot state, so a render site cannot silently drop it. */
function runStateOf(container: HTMLElement): string | null {
  return container.querySelector('[data-terminal] [data-state]')?.getAttribute('data-state') ?? null
}

const SID = 's1' as SessionId

const ARGS = '{"command":"ls -la","description":"List files"}'

/** The bash tool's own call view for a foreground command. */
const callTerminal = (over?: Partial<Extract<ToolCallView, { card: 'terminal' }>>): ToolCallView => ({
  card: 'terminal', title: 'ls -la', description: 'List files', ...over,
})

/** The bash tool's own result view for a settled foreground command. */
const resultTerminal = (over?: Partial<Extract<ToolResultView, { card: 'terminal' }>>): ToolResultView => ({
  card: 'terminal', output: 'a.ts  b.ts\nc.ts  d.ts\n', exitCode: 0, ...over,
})

const running = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'bash', argsRaw: ARGS,
  turn: 1, step: 1, time: 1_000, callView: callTerminal(), ...over,
})

const settled = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'bash', argsRaw: ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'a.ts  b.ts\nc.ts  d.ts\n' }], isError: false,
  callView: callTerminal(), resultView: resultTerminal(), ...over,
})

describe('terminalCardModel', () => {
  it('derives a running card from the call view alone', () => {
    expect(terminalCardModel(running({ callView: callTerminal({ cwd: '/projects/app' }) }))).toEqual({
      command: 'ls -la', cwd: '/projects/app', output: undefined,
      exitCode: undefined, signal: undefined, running: true,
    })
  })

  it('derives a settled card from both sides, carrying the exit status', () => {
    expect(terminalCardModel(settled({
      callView: callTerminal({ cwd: '/projects/app' }),
      resultView: resultTerminal({ output: 'boom\n', exitCode: 2 }),
    }))).toEqual({
      command: 'ls -la', cwd: '/projects/app', output: 'boom\n',
      exitCode: 2, signal: undefined, running: false,
    })
    expect(terminalCardModel(settled({
      resultView: { card: 'terminal', output: '', signal: 'SIGTERM' },
    }))?.signal).toBe('SIGTERM')
  })

  it('takes the result view\'s replacement title over the pending one', () => {
    // The presentation contract defines a result title as REPLACING the pending
    // title, so a tool that rewrites it at settle time must win here.
    expect(terminalCardModel(settled({
      callView: callTerminal({ title: 'pnpm run check' }),
      resultView: resultTerminal({ title: 'pnpm run check --filter web' }),
    }))?.command).toBe('pnpm run check --filter web')
    // Without one, the call's title is what the card keeps.
    expect(terminalCardModel(settled())?.command).toBe('ls -la')
  })

  it('resolves the cwd against the session workspace the way the bridge must', () => {
    // Omitted workdir — the common bash call — IS the session workspace.
    expect(terminalCardModel(settled(), '/w/app')?.cwd).toBe('/w/app')
    // A relative workdir joins under it.
    expect(terminalCardModel(settled({
      callView: callTerminal({ cwd: 'packages/ui' }),
    }), '/w/app')?.cwd).toBe('/w/app/packages/ui')
    // An absolute one is used as-is.
    expect(terminalCardModel(settled({
      callView: callTerminal({ cwd: '/srv/other' }),
    }), '/w/app')?.cwd).toBe('/srv/other')
    // With no session cwd there is nothing to resolve against: a relative path
    // stays as authored and an omitted one stays absent (a bare `$` prompt).
    expect(terminalCardModel(settled({
      callView: callTerminal({ cwd: 'packages/ui' }),
    }))?.cwd).toBe('packages/ui')
    expect(terminalCardModel(settled())?.cwd).toBeUndefined()
    // The running arm resolves identically.
    expect(terminalCardModel(running(), '/w/app')?.cwd).toBe('/w/app')
  })

  it('a window-truncated call side falls back to the result title, then to an empty command', () => {
    // Truncation drops both the call head and its view (conversation.ts).
    const truncated = { call: null, callView: null }
    expect(terminalCardModel(settled({
      ...truncated, resultView: resultTerminal({ title: 'ls -la' }),
    }))).toMatchObject({ command: 'ls -la', cwd: undefined, running: false })
    expect(terminalCardModel(settled(truncated))).toMatchObject({ command: '', cwd: undefined })
  })

  it('returns null for every non-terminal call: no views, generic views, unknown cards', () => {
    expect(terminalCardModel(running({ callView: null }))).toBeNull()
    expect(terminalCardModel(settled({ callView: null, resultView: null }))).toBeNull()
    expect(terminalCardModel(running({ callView: { card: 'generic', title: 'read x' } }))).toBeNull()
    // A generic result settles a terminal call as a generic card (the bash
    // tool's own execution-error and background paths).
    expect(terminalCardModel(settled({ resultView: { card: 'generic' } }))).toBeNull()
    // A card tag this UI version does not know arrives over the wire; the
    // documented generic-card default takes it, not a crash.
    const future = { card: 'chart', title: 'plot' } as unknown as ToolCallView
    expect(terminalCardModel(running({ callView: future }))).toBeNull()
    expect(terminalCardModel(settled({
      callView: future, resultView: { card: 'chart' } as unknown as ToolResultView,
    }))).toBeNull()
  })
})

describe('chat row terminal body', () => {
  const ownerProps = (block: RunningToolCall | ToolResultNode): ToolRowOwnerProps => ({
    callId: 'c1', toolName: 'bash', block, openFile: vi.fn(),
  })

  it('the expanded body is the command output, capped tighter than the panel', () => {
    expect(CHAT_TERMINAL_MAX_LINES).toBeLessThan(16)
    const view = render(<GenericToolCard {...ownerProps(settled())} />)
    // Collapsed: the one-line summary row only, no output.
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.queryByText(/a\.ts/)).toBeNull()
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.getByText('a.ts  b.ts', RAW)).toBeTruthy()
    expect(view.getByText('ls -la')).toBeTruthy()
    // The args JSON body the generic path would have shown is gone.
    expect(view.queryByText(/"command"/)).toBeNull()
  })

  it('the cap collapses a long output inside the row, expandable in place', () => {
    const lines = Array.from({ length: CHAT_TERMINAL_MAX_LINES + 3 }, (_, i) => `line-${i}`)
    const view = render(<GenericToolCard {...ownerProps(settled({
      resultView: resultTerminal({ output: `${lines.join('\n')}\n` }),
    }))} />)
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.getByText('… 其余 3 行')).toBeTruthy()
    expect(view.queryByText('line-5')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '展开其余 3 行输出' }))
    expect(view.getByText('line-5')).toBeTruthy()
  })

  it('renders a multi-line command as one prompt row per line', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      callView: callTerminal({ title: 'ls -la\necho done' }),
    }))} />)
    fireEvent.click(view.container.querySelector('button')!)
    const rows = view.container.querySelectorAll('[class^="_promptLine_"]')
    expect([...rows].map(row => row.textContent)).toEqual(['$ls -la', '$echo done'])
    // Still one dot for the call, on the first row.
    expect(view.container.querySelectorAll('[data-terminal] [data-state]')).toHaveLength(1)
  })

  it('a running terminal call expands to the prompt line with no output yet', () => {
    const view = render(<GenericToolCard {...ownerProps(running())} />)
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.getByText('ls -la')).toBeTruthy()
    expect(view.queryByText('复制')).toBeNull()
    // The card states its own run state: a running command reads as running
    // even though it has no output yet to distinguish it from an empty settle.
    expect(runStateOf(view.container)).toBe('ongoing')
  })

  it('a non-terminal call keeps the args-JSON text body', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      callView: null, resultView: null,
    }))} />)
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.getByText(/"command"/)).toBeTruthy()
  })

  it('a terminal call with no args still expands, through its terminal body alone', () => {
    // Empty args make the text body null; the terminal material carries the row.
    const view = render(<GenericToolCard {...ownerProps(settled({
      call: { name: 'bash', argsRaw: '' },
    }))} />)
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.getByText('a.ts  b.ts', RAW)).toBeTruthy()
  })
})

describe('BashRow terminal card', () => {
  const list = () => createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, updatedAt: 0 } },
    current: undefined,
    phase: 'ready',
  })

  const rowProps = (block: RunningToolCall | ToolResultNode): ToolRowProps => ({
    callId: 'c1', toolName: 'bash', block, openFile: vi.fn(),
    sessionId: SID, useSessions: bindSnapshotSelector(list()),
  } as unknown as ToolRowProps)

  it('renders the command output under the summary row, without an expand gesture', () => {
    const view = render(<BashRow {...rowProps(settled())} />)
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.getByText('a.ts  b.ts', RAW)).toBeTruthy()
    // The card's controls are the row's only interactions: a bash row is not a
    // path link and no longer a details-panel target, so nothing here navigates.
    expect(view.container.querySelector('[data-clickable]')).toBeNull()
    expect(view.getByText('复制')).toBeTruthy()
  })

  // The row's leading StateDot and the card's run-state dot describe the same
  // command, so a running row whose card claimed 'done' would be a contradiction
  // the reader sees on one line.
  it('agrees with the summary row about the run state', () => {
    const runningView = render(<BashRow {...rowProps(running())} />)
    expect(runningView.container.querySelector('[data-variant="bash"]')?.getAttribute('data-state')).toBe('running')
    expect(runStateOf(runningView.container)).toBe('ongoing')
    cleanup()
    const settledView = render(<BashRow {...rowProps(settled())} />)
    expect(settledView.container.querySelector('[data-variant="bash"]')?.getAttribute('data-state')).toBe('ok')
    expect(runStateOf(settledView.container)).toBe('done')
  })

  it('a non-terminal bash call (background start) renders the summary row alone', () => {
    const view = render(<BashRow {...rowProps(settled({
      callView: { card: 'generic', title: 'sleep 30', kind: 'execute' },
      resultView: { card: 'generic' },
    }))} />)
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.queryByText(/a\.ts/)).toBeNull()
  })
})

describe('DetailsPanel Output section', () => {
  function mount(snapshot: ConversationSnapshot, selection: SelectionTarget | null, cwd?: string) {
    localStorage.clear()
    const chat = createChatStore().create()
    if (selection !== null) chat.actions.select(selection)
    const sessions = createSnapshotStore<SessionListState>(cwd === undefined
      ? { ids: [], byId: {}, current: undefined, phase: 'ready' }
      : {
        ids: [SID],
        byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, updatedAt: 0, cwd } },
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

  const target: SelectionTarget = { turnSeq: 10, callId: 'c1', toolName: 'bash' }

  // The panel never unmounts between selections, so per-call view state has to
  // be keyed off the selected call or it leaks into the next one.
  it('resets the card\'s expand state when the selected call changes', () => {
    const long = Array.from({ length: 20 }, (_, i) => `row-${i}`)
    const view = mount(snapshot({
      nodes: [settled({ resultView: resultTerminal({ output: `${long.join('\n')}\n` }) })],
    }), target)
    fireEvent.click(view.getByRole('button', { name: '展开其余 4 行输出' }))
    expect(view.getByRole('button', { name: '收起输出' })).toBeTruthy()
    // A second call, selected without unmounting the panel, starts collapsed.
    cleanup()
    const second = mount(snapshot({
      nodes: [settled({
        callId: 'c2', resultView: resultTerminal({ output: `${long.join('\n')}\n` }),
      })],
    }), { turnSeq: 10, callId: 'c2', toolName: 'bash' })
    expect(second.getByRole('button', { name: '展开其余 4 行输出' })).toBeTruthy()
  })

  it('resolves the prompt cwd against the session workspace', () => {
    const view = mount(snapshot({ nodes: [settled()] }), target, '/w/app')
    // No workdir in the call view: the prompt label is the workspace basename.
    expect(view.getByText('app')).toBeTruthy()
  })

  it('renders the terminal card at full height, keeping the JSON Input section', () => {
    const long = Array.from({ length: 20 }, (_, i) => `row-${i}`)
    const view = mount(snapshot({
      nodes: [settled({ resultView: resultTerminal({ output: `${long.join('\n')}\n` }) })],
    }), target)
    expect(view.getByText(/"command"/)).toBeTruthy()
    expect(view.getByText('ls -la')).toBeTruthy()
    // The panel takes the primitive's own default cap (16), not the row's.
    expect(view.getByText(`… 其余 ${20 - 16} 行`)).toBeTruthy()
    expect(view.getByText('row-0')).toBeTruthy()
  })

  it('a running terminal call shows the prompt line, not the 运行中… placeholder', () => {
    const view = mount(snapshot({ runningCalls: [running()] }), target)
    expect(view.getByText('ls -la')).toBeTruthy()
    expect(view.queryByText('运行中…')).toBeNull()
    expect(runStateOf(view.container)).toBe('ongoing')
  })

  it('a running non-terminal call keeps the 运行中… placeholder', () => {
    const view = mount(snapshot({ runningCalls: [running({ callView: null })] }), target)
    expect(view.getByText('运行中…')).toBeTruthy()
  })

  it('a non-terminal result keeps the flattened pre with its error styling', () => {
    const view = mount(snapshot({
      nodes: [settled({
        callView: null, resultView: null, isError: true,
        content: [{ type: 'text', text: 'permission denied' }],
      })],
    }), target)
    const pre = view.container.querySelector('pre[data-error]')
    expect(pre?.textContent).toBe('permission denied')
  })

  it('a run_code sub-dispatch resolves to its own terminal card', () => {
    const view = mount(snapshot({
      codeDispatches: new Map([['p1', [settled({ callId: 'c1' })]]]),
    }), target)
    expect(view.getByText('a.ts  b.ts', RAW)).toBeTruthy()
  })

  it('a running run_code sub-dispatch resolves through the running material', () => {
    const view = mount(snapshot({
      // The leading non-matching sub-call exercises the scan's skip.
      codeDispatches: new Map([['p1', [running({ callId: 'other' }), running()]]]),
    }), target)
    expect(view.getByText('ls -la')).toBeTruthy()
  })

  it('a window-truncated call head titles the panel by callId and drops the Input section', () => {
    const view = mount(snapshot({
      nodes: [settled({ call: null, callView: null, resultView: resultTerminal({ title: 'ls -la' }) })],
    }), target)
    expect(view.getByText('c1')).toBeTruthy()
    expect(view.queryByText('Input')).toBeNull()
    expect(view.getByText('Output')).toBeTruthy()
  })

  it('scans past other nodes and other calls before reporting the call out of window', () => {
    const view = mount(snapshot({
      nodes: [
        { kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1, blocks: [] },
        settled({ callId: 'elsewhere' }),
      ],
      runningCalls: [running({ callId: 'also-elsewhere' })],
    }), target)
    expect(view.getByText('该调用不在当前窗口内')).toBeTruthy()
  })

  it('no selection at all renders the guidance line and the default title', () => {
    const view = mount(snapshot(), null)
    expect(view.getByText('详情')).toBeTruthy()
    expect(view.getByText('点击消息流中的工具行查看详情')).toBeTruthy()
  })

  it('a step selection without a callId renders the guidance line too', () => {
    const view = mount(snapshot(), { turnSeq: 3, stepSeq: 1 })
    expect(view.getByText('点击消息流中的工具行查看详情')).toBeTruthy()
  })

  it('the close button reaches closeDetails', () => {
    localStorage.clear()
    const chat = createChatStore().create()
    const closeDetails = vi.fn()
    const snap = snapshot()
    const view = render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector({ getSnapshot: () => snap, subscribe: () => () => {} })}
        useSessions={bindSnapshotSelector(createSnapshotStore<SessionListState>(
          { ids: [], byId: {}, current: undefined, phase: 'ready' }))}
        useWorkspaces={bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
          items: [], state: 'idle', phase: 'ready', error: null,
          baselinesReady: true, recentWorkspaceId: undefined,
        }))}
        useInput={(() => { throw new Error('unused') })}
        inputActions={{ setDraft: () => {}, submit: () => {} }}
        useProjection={(() => undefined)}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={closeDetails}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: '关闭详情' }))
    expect(closeDetails).toHaveBeenCalledTimes(1)
  })

  it('a non-text result block renders as JSON, and an empty result falls back to its error', () => {
    const nonText = mount(snapshot({
      nodes: [settled({
        callView: null, resultView: null,
        content: [{ type: 'reasoning', text: 'why' }],
      })],
    }), target)
    // Scope to the Output section: the Input section's CodeBlock renders a
    // <pre> of its own, and it comes first in document order.
    expect(nonText.getByText('Output').closest('section')?.querySelector('pre')?.textContent)
      .toBe('{\n  "type": "reasoning",\n  "text": "why"\n}')
    cleanup()
    const empty = mount(snapshot({
      nodes: [settled({
        callView: null, resultView: null, content: [], isError: true,
        error: { name: 'ToolError', code: 'interrupted' },
      })],
    }), target)
    expect(empty.getByText('ToolError: interrupted')).toBeTruthy()
  })
})
