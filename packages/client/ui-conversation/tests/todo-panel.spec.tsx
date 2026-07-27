// @vitest-environment jsdom
/**
 * Todo display acceptance: the TodoPanel plan strip (empty-hidden, status
 * rows, collapse with active hint), its TodoDock adapter (selects the plan off
 * the session snapshot and follows changes), and the todo_write toolview row
 * (progress summary from args, generic fallback on malformed JSON, error badge,
 * keyboard activation).
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

  it('shows progress, one row per item with its status, and strikes done items', () => {
    render(<TodoPanel todos={LIST} />)
    expect(screen.getByTestId('todo-panel')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
    const items = screen.getAllByRole('listitem')
    expect(items.map(li => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(screen.getByText('搭骨架')).toBeTruthy()
    expect(screen.getByText('写组件')).toBeTruthy()
  })

  it('collapse hides the list and surfaces the active item in the header; expand restores', () => {
    render(<TodoPanel todos={LIST} />)
    const header = screen.getByRole('button', { expanded: true })
    fireEvent.click(header)
    expect(screen.queryByRole('list')).toBeNull()
    // Collapsed header carries the in-progress content as the one-line hint.
    expect(screen.getByText('写组件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('collapsed header omits the hint when nothing is in progress', () => {
    render(<TodoPanel todos={[{ content: '都完了', status: 'completed' }]} />)
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('都完了')).toBeNull()
    expect(screen.getByText('1/1')).toBeTruthy()
  })
})

/** Dock props stub: the adapter reads useSession only; the rest of the owner share is unused. */
function dockProps(store: ReturnType<typeof createSnapshotStore<{ todos: readonly TodoItem[] }>>): TodoDockProps {
  return { useSession: bindSnapshotSelector(store) } as unknown as TodoDockProps
}

describe('TodoDock', () => {
  it('selects the plan off the session snapshot and follows later writes', () => {
    const store = createSnapshotStore<{ todos: readonly TodoItem[] }>({ todos: [] })
    render(<TodoDock {...dockProps(store)} />)
    expect(screen.queryByTestId('todo-panel')).toBeNull()
    act(() => { store.set({ todos: LIST }) })
    expect(screen.getByText('1/3')).toBeTruthy()
    // A rollback to the empty list retires the strip (the panel owns no data).
    act(() => { store.set({ todos: [] }) })
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

function rowProps(block: unknown, openDetails = vi.fn()): ToolRowProps {
  return {
    callId: 'c1', toolName: 'todo_write', block,
    openDetails,
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

  it('keeps the non-ok execution states visible: running dot, interrupted marker', () => {
    // A running call (no result yet) shows the ongoing dot, never the ok badge.
    const args = JSON.stringify({ todos: LIST })
    const running = render(<TodoRow {...rowProps({ callId: 'c1', name: 'todo_write', argsRaw: args, turn: 1, step: 1, time: 1_000, callView: null })} />)
    expect(running.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(running.container.querySelector('[data-state="running"] svg')).not.toBeNull()
    running.unmount()
    // A cancelled call wrote no todo/write: the row must not read as a completed update.
    const stopped = render(<TodoRow {...rowProps(resultNode(args, { isError: true, error: { name: 'Interrupted', code: 'interrupted' } }))} />)
    expect(stopped.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    expect(stopped.getByText('已中断')).toBeTruthy()
  })

  it('falls back to the generic summary on malformed args and flags errors', () => {
    render(<TodoRow {...rowProps(resultNode('not json', { isError: true }))} />)
    expect(screen.getByText('failed')).toBeTruthy()
    // Generic others summary: "<tool> · <raw>".
    expect(screen.getByText('todo_write · not json')).toBeTruthy()
  })

  it('falls back when parsed args carry no todos array, and click opens details', () => {
    const openDetails = vi.fn()
    render(<TodoRow {...rowProps(resultNode('{"other":1}'), openDetails)} />)
    expect(screen.getByText('todo_write · {"other":1}')).toBeTruthy()
    fireEvent.click(screen.getByText('更新任务清单'))
    expect(openDetails).toHaveBeenCalledTimes(1)
  })

  it('opens details from the keyboard on Enter and Space, ignoring other keys', () => {
    const openDetails = vi.fn()
    render(<TodoRow {...rowProps(resultNode(ARGS), openDetails)} />)
    const row = screen.getByRole('button')
    expect(row.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(openDetails).toHaveBeenCalledTimes(2)
    // Space must not also scroll the flow: the handler claims the event.
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false)
    fireEvent.keyDown(row, { key: 'a' })
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    expect(openDetails).toHaveBeenCalledTimes(3)
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
