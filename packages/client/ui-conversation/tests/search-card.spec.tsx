// @vitest-environment jsdom
// The search render intent on the web side: the pure searchCardModel derivation
// over resultView, and the conversation render sites that consume it — the chat
// tool row (GenericToolCard's expand-gated body and SearchRow's resident card)
// and the details panel's Output section. The keyed registration under both grep
// and glob is pinned here too.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, RunningToolCall, SessionId, SessionListState, ToolResultNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolResultView } from '@deepseek-ai/dsh-client-connection/client'
import type { SelectionTarget, ToolRowOwnerProps, ToolRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_SEARCH_MAX_LINES, searchCardModel } from '../src/client/contract/search-card-model.ts'
import { createChatStore } from '../src/client/stores.ts'
import { GenericToolCard } from '../src/client/chat/GenericToolCard.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import { SearchRow, searchToolview } from '../src/client/toolviews/search-sample.tsx'

afterEach(cleanup)

/** The rendered search card's kind attribute, so a render site cannot silently drop it. */
function searchKindOf(container: HTMLElement): string | null {
  return container.querySelector('[data-search]')?.getAttribute('data-search') ?? null
}

/** The rendered result rows of the search card, one string per visible row. */
function searchRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-search] [class^="_line_"]')].map(row => row.textContent ?? '')
}

const SID = 's1' as SessionId

const GREP_ARGS = '{"pattern":"foo","path":"src"}'
const GLOB_ARGS = '{"pattern":"**/*.ts","path":"src"}'

/** A grep result view: matches grouped by file. */
const resultMatches = (over?: Partial<Extract<ToolResultView, { card: 'search'; kind: 'matches' }>>): ToolResultView => ({
  card: 'search', kind: 'matches',
  files: [
    { path: 'a.ts', matches: [{ lineNumber: 12, line: 'const foo = 1' }, { lineNumber: 40, line: 'return foo' }] },
    { path: 'b.ts', matches: [{ lineNumber: 7, line: 'foo()' }] },
  ],
  truncated: false, total: 3, ...over,
})

/** A glob result view: a flat path list. */
const resultPaths = (over?: Partial<Extract<ToolResultView, { card: 'search'; kind: 'paths' }>>): ToolResultView => ({
  card: 'search', kind: 'paths', paths: ['src/a.ts', 'src/b.ts'], truncated: false, total: 2, ...over,
})

const runningGrep = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'grep', argsRaw: GREP_ARGS,
  turn: 1, step: 1, time: 1_000, callView: { card: 'generic', title: 'Grep foo', kind: 'search' }, ...over,
})

const settledGrep = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'grep', argsRaw: GREP_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'a.ts\n  Line 12: const foo = 1' }], isError: false,
  callView: { card: 'generic', title: 'Grep foo', kind: 'search' }, resultView: resultMatches(), ...over,
})

const settledGlob = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 11, time: 2_000, callId: 'c2',
  call: { name: 'glob', argsRaw: GLOB_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'src/a.ts\nsrc/b.ts' }], isError: false,
  callView: { card: 'generic', title: 'Glob **/*.ts', kind: 'search' }, resultView: resultPaths(), ...over,
})

describe('searchCardModel', () => {
  it('derives a matches card from the grep result view', () => {
    expect(searchCardModel(settledGrep())).toEqual({
      title: undefined,
      card: {
        kind: 'matches',
        files: [
          { path: 'a.ts', matches: [{ lineNumber: 12, line: 'const foo = 1' }, { lineNumber: 40, line: 'return foo' }] },
          { path: 'b.ts', matches: [{ lineNumber: 7, line: 'foo()' }] },
        ],
        truncated: false, total: 3,
      },
    })
  })

  it('derives a paths card from the glob result view, carrying the truncation signal', () => {
    expect(searchCardModel(settledGlob({ resultView: resultPaths({ truncated: true, total: 20 }) }))).toEqual({
      title: undefined,
      card: { kind: 'paths', paths: ['src/a.ts', 'src/b.ts'], truncated: true, total: 20 },
    })
  })

  it('carries the result view\'s replacement title when the presenter sets one', () => {
    expect(searchCardModel(settledGrep({ resultView: resultMatches({ title: '3 matches' }) }))?.title).toBe('3 matches')
    // Without one it is absent, so the row keeps its args-derived summary.
    expect(searchCardModel(settledGrep())?.title).toBeUndefined()
  })

  it('returns null for every non-search call: running, no views, generic, terminal, unknown cards', () => {
    // A search card is result-time only: a running call has no result view yet.
    expect(searchCardModel(runningGrep())).toBeNull()
    expect(searchCardModel(settledGrep({ callView: null, resultView: null }))).toBeNull()
    // A generic result settles a search call as a generic card (grep/glob failure
    // or a nested run_code dispatch), which keeps the generic path.
    expect(searchCardModel(settledGrep({ resultView: { card: 'generic' } }))).toBeNull()
    // A terminal result view is a different card entirely.
    expect(searchCardModel(settledGrep({ resultView: { card: 'terminal', output: 'x' } }))).toBeNull()
    // A card tag this UI version does not know arrives over the wire; the
    // documented generic-card default takes it, not a crash.
    const future = { card: 'chart' } as unknown as ToolResultView
    expect(searchCardModel(settledGrep({ resultView: future }))).toBeNull()
  })
})

describe('chat row search body (GenericToolCard fallback)', () => {
  const ownerProps = (block: RunningToolCall | ToolResultNode, toolName: string): ToolRowOwnerProps => ({
    callId: 'c1', toolName, block, openFile: vi.fn(),
  })

  it('the expanded body is the grouped matches, capped tighter than the panel', () => {
    expect(CHAT_SEARCH_MAX_LINES).toBeLessThan(16)
    const view = render(<GenericToolCard {...ownerProps(settledGrep(), 'grep')} />)
    // Collapsed: the one-line summary row only, no card.
    expect(view.queryByText(/const foo = 1/)).toBeNull()
    fireEvent.click(view.container.querySelector('button')!)
    expect(searchRows(view.container)).toContain('12: const foo = 1')
    expect(view.getByText('a.ts')).toBeTruthy()
    expect(searchKindOf(view.container)).toBe('matches')
    // The args JSON body the generic path would have shown is gone.
    expect(view.queryByText(/"pattern"/)).toBeNull()
  })

  it('the glob fallback expands to the flat path card', () => {
    const view = render(<GenericToolCard {...ownerProps(settledGlob(), 'glob')} />)
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.getByText('src/a.ts')).toBeTruthy()
    expect(searchKindOf(view.container)).toBe('paths')
  })

  it('a non-search result keeps the args-JSON text body', () => {
    const view = render(<GenericToolCard {...ownerProps(settledGrep({
      resultView: { card: 'generic' },
    }), 'grep')} />)
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.getByText(/"pattern"/)).toBeTruthy()
    expect(searchKindOf(view.container)).toBeNull()
  })
})

describe('SearchRow keyed card', () => {
  const rowProps = (block: RunningToolCall | ToolResultNode, toolName: string): ToolRowProps => ({
    callId: 'c1', toolName, block, openFile: vi.fn(), sessionId: SID,
  } as unknown as ToolRowProps)

  it('renders the grep card resident under the summary row, without an expand gesture', () => {
    const view = render(<SearchRow {...rowProps(settledGrep(), 'grep')} />)
    expect(view.getByText('Search')).toBeTruthy()
    expect(searchRows(view.container)).toContain('12: const foo = 1')
    expect(searchKindOf(view.container)).toBe('matches')
    // The card's controls are the row's only interactions.
    expect(view.getByText('复制')).toBeTruthy()
  })

  it('renders the glob path card resident', () => {
    const view = render(<SearchRow {...rowProps(settledGlob(), 'glob')} />)
    expect(view.getByText('src/a.ts')).toBeTruthy()
    expect(searchKindOf(view.container)).toBe('paths')
  })

  it('agrees with the summary row about the run state', () => {
    const runningView = render(<SearchRow {...rowProps(runningGrep(), 'grep')} />)
    expect(runningView.container.querySelector('[data-variant="search"]')?.getAttribute('data-state')).toBe('running')
    // No result view yet, so no resident card.
    expect(searchKindOf(runningView.container)).toBeNull()
    cleanup()
    const errorView = render(<SearchRow {...rowProps(settledGrep({
      isError: true, resultView: { card: 'generic' },
    }), 'grep')} />)
    expect(errorView.container.querySelector('[data-variant="search"]')?.getAttribute('data-state')).toBe('error')
  })

  it('shows the result view\'s replacement title instead of the args summary', () => {
    const view = render(<SearchRow {...rowProps(settledGrep({
      resultView: resultMatches({ title: '3 matches in 2 files' }),
    }), 'grep')} />)
    expect(view.getByText('3 matches in 2 files')).toBeTruthy()
  })

  it('keeps the args-derived summary when the result view has no title', () => {
    const view = render(<SearchRow {...rowProps(settledGrep(), 'grep')} />)
    expect(view.getByText('foo')).toBeTruthy()
  })

  it('registers the one row component under both grep and glob keys', () => {
    const registered: { key: unknown; component: unknown }[] = []
    const ctx = {
      slots: {
        register: (options: { name: string; key: string }, component: unknown) => {
          registered.push({ key: options.key, component })
        },
      },
    } as never
    searchToolview.apply(ctx)
    expect(registered.map(r => r.key)).toEqual(['grep', 'glob'])
    // One component, two keys.
    expect(registered[0]!.component).toBe(SearchRow)
    expect(registered[1]!.component).toBe(SearchRow)
    expect(searchToolview.inject).toEqual(['slots', 'conversation'])
  })
})

describe('DetailsPanel Output section (search)', () => {
  function mount(snapshot: ConversationSnapshot, selection: SelectionTarget | null) {
    localStorage.clear()
    const chat = createChatStore().create()
    if (selection !== null) chat.actions.select(selection)
    const sessions = createSnapshotStore<SessionListState>({ ids: [], byId: {}, current: undefined, phase: 'ready' })
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

  const grepTarget: SelectionTarget = { turnSeq: 10, callId: 'c1', toolName: 'grep' }
  const globTarget: SelectionTarget = { turnSeq: 11, callId: 'c2', toolName: 'glob' }

  it('renders the grep matches card at full height, keeping the JSON Input section', () => {
    const view = mount(snapshot({ nodes: [settledGrep()] }), grepTarget)
    expect(view.getByText(/"pattern"/)).toBeTruthy()
    expect(searchRows(view.container)).toContain('12: const foo = 1')
    expect(searchKindOf(view.container)).toBe('matches')
  })

  it('renders the glob path card', () => {
    const view = mount(snapshot({ nodes: [settledGlob()] }), globTarget)
    expect(view.getByText('src/a.ts')).toBeTruthy()
    expect(searchKindOf(view.container)).toBe('paths')
  })

  it('a non-search result keeps the flattened pre form', () => {
    const view = mount(snapshot({
      nodes: [settledGrep({ callView: null, resultView: null })],
    }), grepTarget)
    expect(searchKindOf(view.container)).toBeNull()
    const output = view.getByText('Output').closest('section')
    expect(output?.querySelector('pre')?.textContent).toContain('const foo = 1')
  })
})
