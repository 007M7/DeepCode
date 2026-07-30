// @vitest-environment jsdom
/**
 * Todo display acceptance: the TodoPanel plan strip (empty-hidden, status
 * rows, collapse), its TodoDock adapter (selects the plan off the session
 * snapshot and follows changes), and the todo_write toolview row (progress
 * summary from args, generic fallback on malformed JSON, shared ToolRow
 * state dots and leading expansion).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TodoItem, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Export discipline: packages/client/AGENTS.md.
import { TodoRow, todoToolview } from '../src/client/toolviews/todo-row.tsx'
import type { TodoDockProps } from '../src/client/skeleton/TodoPanel.tsx'
import { TodoDock, TodoPanel, todoDockEntry } from '../src/client/skeleton/TodoPanel.tsx'

afterEach(cleanup)

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

describe('TodoPanel', () => {
  it('renders nothing while the list is empty', () => {
    const { container } = render(<TodoPanel todos={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('starts collapsed with the progress summary visible', () => {
    render(<TodoPanel todos={LIST} />)
    expect(screen.getByTestId('todo-panel')).toBeTruthy()
    expect(screen.getByText('To-dos')).toBeTruthy()
    expect(screen.getByText('1/3 tasks · 1 in progress')).toBeTruthy()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('expands to show one row per item with its status glyph', () => {
    render(<TodoPanel todos={LIST} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const items = screen.getAllByRole('listitem')
    expect(items.map(li => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(screen.getByText('搭骨架')).toBeTruthy()
    expect(screen.getByText('写组件')).toBeTruthy()
    // Each status row carries an SVG glyph (not a text bullet).
    expect(items.every(li => li.querySelector('svg') !== null)).toBe(true)
  })

  it('collapse hides an expanded list; expand restores; header keeps the count summary', () => {
    render(<TodoPanel todos={LIST} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const header = screen.getByRole('button', { expanded: true })
    fireEvent.click(header)
    expect(screen.queryByRole('list')).toBeNull()
    // Collapsed header is title + progress only (no in-progress content hint).
    expect(screen.getByText('1/3 tasks · 1 in progress')).toBeTruthy()
    expect(screen.queryByText('写组件')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('collapsed header still shows zero in-progress when nothing is active', () => {
    render(<TodoPanel todos={[{ content: '都完了', status: 'completed' }]} />)
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(screen.queryByText('都完了')).toBeNull()
    expect(screen.getByText('1/1 tasks · 0 in progress')).toBeTruthy()
  })
})

/** Dock props stub: the adapter reads the 'todos' projection only; the rest of the owner share is unused. */
function dockProps(store: ReturnType<typeof createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>>): TodoDockProps {
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  return { useProjection } as unknown as TodoDockProps
}

describe('TodoDock', () => {
  it('reads the host-computed todos projection and follows pushed updates', () => {
    const store = createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>({ value: undefined })
    render(<TodoDock {...dockProps(store)} />)
    // Capability absent (no baseline/frame yet) renders nothing.
    expect(screen.queryByTestId('todo-panel')).toBeNull()
    act(() => { store.set({ value: LIST }) })
    expect(screen.getByText('1/3 tasks · 1 in progress')).toBeTruthy()
    // The pre-first-write whole value (null) retires the strip (the panel owns no data).
    act(() => { store.set({ value: null }) })
    expect(screen.queryByTestId('todo-panel')).toBeNull()
  })

  it('ships the registrant plugin shape (list entry above the queue rows)', () => {
    expect(todoDockEntry.name).toBe('conversation-todo-dock')
    expect(todoDockEntry.inject).toEqual(['slots', 'conversation'])
    const register = vi.fn()
    todoDockEntry.apply({ slots: { register } } as never)
    expect(register).toHaveBeenCalledWith({ name: 'conversation.input.dock', id: 'todo', order: -1 }, TodoDock)
  })
})

const resultNode = (argsRaw: string, over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
  call: { name: 'todo_write', argsRaw },
  content: [], isError: false, callView: null, resultView: null, ...over,
})

function rowProps(block: unknown): ToolRowProps {
  return {
    callId: 'c1', toolName: 'todo_write', block,
    openFile: vi.fn(),
    sessionId: 's1',
    useSessions: () => undefined,
  } as unknown as ToolRowProps
}

describe('TodoRow', () => {
  const ARGS = JSON.stringify({ todos: LIST })

  it('summarizes counts and the active item from the call args', () => {
    render(<TodoRow {...rowProps(resultNode(ARGS))} />)
    expect(screen.getByText('更新任务清单')).toBeTruthy()
    expect(screen.getByText('1/3 已完成 · 写组件')).toBeTruthy()
  })

  it('omits the active clause when no item is in progress and reads running-call args', () => {
    const args = JSON.stringify({ todos: [{ content: 'x', status: 'completed' }] })
    render(<TodoRow {...rowProps({ callId: 'c1', name: 'todo_write', argsRaw: args, turn: 1, step: 1, time: 1_000, callView: null })} />)
    expect(screen.getByText('1/1 已完成')).toBeTruthy()
  })

  it('keeps the non-ok execution states visible through the shared row states', () => {
    // A running call (no result yet) carries the running state (row sweep).
    const args = JSON.stringify({ todos: LIST })
    const running = render(<TodoRow {...rowProps({ callId: 'c1', name: 'todo_write', argsRaw: args, turn: 1, step: 1, time: 1_000, callView: null })} />)
    expect(running.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(running.container.querySelector('[data-state="running"] svg')).not.toBeNull()
    running.unmount()
    // A cancelled call wrote no todo/write: the row must not read as a completed update.
    const stopped = render(<TodoRow {...rowProps(resultNode(args, { isError: true, error: { name: 'Interrupted', code: 'interrupted' } }))} />)
    expect(stopped.container.querySelector('[data-state="stopped"]')).not.toBeNull()
  })

  it('falls back to the generic summary on malformed args and marks the error state', () => {
    const view = render(<TodoRow {...rowProps(resultNode('not json', { isError: true }))} />)
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
    // Generic others summary: "<tool> · <raw>".
    expect(screen.getByText('todo_write · not json')).toBeTruthy()
  })

  it('falls back when parsed args carry no todos array', () => {
    render(<TodoRow {...rowProps(resultNode('{"other":1}'))} />)
    expect(screen.getByText('todo_write · {"other":1}')).toBeTruthy()
  })

  it('leading toggle expands the raw args body', () => {
    render(<TodoRow {...rowProps(resultNode(ARGS))} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    // The expanded body is the pretty-printed args, not the tool output.
    expect(screen.getByText(/搭骨架/)).toBeTruthy()
  })

  it.each([
    { label: 'null root', argsRaw: 'null' },
    { label: 'non-object root', argsRaw: '42' },
    { label: 'null items', argsRaw: '{"todos":[null]}' },
  ])('falls back to the generic summary on valid JSON with an invalid shape ($label)', ({ argsRaw }) => {
    render(<TodoRow {...rowProps(resultNode(argsRaw))} />)
    // No throw, and the generic others summary carries the raw args verbatim.
    expect(screen.getByText(`todo_write · ${argsRaw}`)).toBeTruthy()
  })

  it('window-truncated result (call head lost) falls back to the callId summary', () => {
    render(<TodoRow {...rowProps(resultNode('', { call: null }))} />)
    expect(screen.getByText('todo_write · c1')).toBeTruthy()
  })

  it('todoToolview is a plain registrant riding the conversation load-order seam', () => {
    expect(todoToolview.name).toBe('todo-toolview')
    expect(todoToolview.inject).toEqual(['slots', 'conversation'])
    const register = vi.fn()
    todoToolview.apply({ slots: { register } } as never)
    expect(register).toHaveBeenCalledWith({ name: 'conversation.chat.toolview', key: 'todo_write' }, TodoRow)
  })
})
