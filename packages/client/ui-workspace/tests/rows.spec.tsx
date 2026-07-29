// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RowDragProps } from '../src/client/rows/Rows.tsx'
import { ProjectRowItem, SessionNodeItem } from '../src/client/rows/Rows.tsx'
import type { GroupNode, SessionNode } from '../src/client/tree.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** Half detection reads the row rect; jsdom rects are all-zero by default. */
function stubRect(row: HTMLElement): void {
  row.getBoundingClientRect = () => ({
    top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34,
    x: 0, y: 100, toJSON: () => ({}),
  })
}

function dragProps(overrides: Partial<RowDragProps> = {}): RowDragProps {
  return {
    start: vi.fn(), active: false, marker: null,
    hover: vi.fn(), drop: vi.fn(), end: vi.fn(),
    ...overrides,
  }
}

const dataTransfer = { effectAllowed: '', dropEffect: '' }

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { ...dataTransfer } })
  fireEvent(row, event)
}

describe('workspace browser rows', () => {
  it('renders an active Workspace and keeps its create action separate from toggling', () => {
    const onToggle = vi.fn()
    const onCreate = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', label: 'Project',
      sessionCount: 1, expanded: true, containsCurrent: true, sessions: [],
    }
    render(<ProjectRowItem group={group} onToggle={onToggle} onCreate={onCreate} />)

    expect(screen.getByText('1 session')).toBeTruthy()
    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'New session in Project' }))
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Project'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('renders and operates selected, running, recursive Session nodes', () => {
    const child: SessionNode = {
      id: sid('child'), title: 'Child', children: [], hasChildren: false,
      expanded: false, running: false, updatedAt: 0,
    }
    const parent: SessionNode = {
      id: sid('parent'), title: 'Parent', children: [child], hasChildren: true,
      expanded: true, running: true, updatedAt: 0,
    }
    const onOpen = vi.fn()
    const onToggle = vi.fn()
    const view = render(
      <SessionNodeItem node={parent} depth={0} currentId={parent.id} now={0} onOpen={onOpen}
        onRename={vi.fn()} onToggle={onToggle} />,
    )

    const parentRow = screen.getByText('Parent').closest('[role="treeitem"]')!
    const childRow = screen.getByText('Child').closest('[role="treeitem"]')!
    expect(parentRow.getAttribute('aria-selected')).toBe('true')
    expect(parentRow.getAttribute('aria-expanded')).toBe('true')
    expect(childRow.getAttribute('aria-selected')).toBe('false')
    expect(childRow.hasAttribute('aria-expanded')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(onToggle).toHaveBeenCalledWith(parent.id)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(parentRow)
    fireEvent.click(childRow)
    expect(onOpen.mock.calls).toEqual([[parent.id], [child.id]])

    view.rerender(
      <SessionNodeItem
        node={{ ...parent, children: [], expanded: false, running: false }}
        depth={1} currentId={undefined} now={0} onOpen={onOpen}
        onRename={vi.fn()} onToggle={onToggle}
      />,
    )
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy()
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('treeitem').style.paddingLeft).toBe('24px')
  })

  it('workspace row menu opens on the ellipsis, renames, and shows the danger delete row', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const onToggle = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', label: 'Project',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: onRename, delete: onDelete }}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Project' }))
    // Opening the menu neither toggles the group nor renames yet.
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' }).className).toMatch(/danger/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRename).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Project' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ungrouped bucket renders no workspace menu', () => {
    const group: GroupNode = {
      key: '', workspaceId: undefined, cwd: undefined, label: 'Ungrouped',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Workspace actions/ })).toBeNull()
  })

  it('session row menu opens without opening the session and dispatches rename', () => {
    const onOpen = vi.fn()
    const onRename = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'One', children: [], hasChildren: false,
      expanded: false, running: false, updatedAt: 0,
    }
    render(<SessionNodeItem node={node} depth={0} currentId={undefined} now={0} onOpen={onOpen}
      onRename={onRename} onToggle={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: 'Delete session' }).className).toMatch(/danger/)
    // Rename dispatches with the current display title (dialog prefill).
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRename).toHaveBeenCalledWith(node.id, 'One')
    expect(onOpen).not.toHaveBeenCalled()
    // Fork and Delete stay visual-only.
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
    expect(onRename).toHaveBeenCalledOnce()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for One' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('flat variant renders no twist even for a parent and ignores toggling', () => {
    const node: SessionNode = {
      id: sid('p'), title: 'Parent', children: [], hasChildren: true,
      expanded: false, running: false, updatedAt: 0,
    }
    render(<SessionNodeItem node={node} depth={0} currentId={undefined} now={0} onOpen={vi.fn()}
      onRename={vi.fn()} onToggle={vi.fn()} flat />)
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull()
  })

  it('shows the hover card after the dwell and suppresses it while the row menu is open', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Hovered', children: [], hasChildren: false,
        expanded: false, running: true, updatedAt: 0,
      }
      render(<SessionNodeItem node={node} depth={0} currentId={undefined} now={60_000} onOpen={vi.fn()}
        onRename={vi.fn()} onToggle={vi.fn()} />)
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      // Card body: full title + relative time + running status.
      expect(screen.getAllByText('Hovered')).toHaveLength(2)
      expect(screen.getByText('1min ago')).toBeTruthy()
      expect(screen.getByText('Running')).toBeTruthy()
      fireEvent.pointerLeave(wrapper)
      // Menu open (disabled=true) suppresses the card for the same hover.
      fireEvent.click(screen.getByRole('button', { name: 'Session actions for Hovered' }))
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByText('1min ago')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('idle hover card shows the Idle status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Quiet', children: [], hasChildren: false,
        expanded: false, running: false, updatedAt: 0,
      }
      render(<SessionNodeItem node={node} depth={0} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onToggle={vi.fn()} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('Idle')).toBeTruthy()
      expect(screen.getByText('now ago')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('draggable row wires start/end and gates hover/drop on an active same-group drag', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Drag me', children: [], hasChildren: false,
      expanded: false, running: false, updatedAt: 0,
    }
    const inactive = dragProps()
    const { rerender } = render(
      <SessionNodeItem node={node} depth={0} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onToggle={vi.fn()} drag={inactive} />,
    )
    const row = screen.getByRole('treeitem')
    stubRect(row)
    expect(row.getAttribute('draggable')).toBe('true')
    fireEvent.dragStart(row, { dataTransfer })
    expect(inactive.start).toHaveBeenCalledOnce()
    // Inactive drag: hover and drop are rejected.
    fireEvent.dragOver(row, { dataTransfer })
    fireEvent.drop(row, { dataTransfer })
    expect(inactive.hover).not.toHaveBeenCalled()
    expect(inactive.drop).not.toHaveBeenCalled()
    fireEvent.dragEnd(row)
    expect(inactive.end).toHaveBeenCalledOnce()

    const active = dragProps({ active: true, marker: 'before' })
    rerender(
      <SessionNodeItem node={node} depth={0} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onToggle={vi.fn()} drag={active} />,
    )
    stubRect(screen.getByRole('treeitem'))
    // Top half hovers/drops 'before'; bottom half 'after' (row mid = 117).
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 105)
    expect(active.hover).toHaveBeenCalledWith('before')
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 130)
    expect(active.hover).toHaveBeenCalledWith('after')
    fireDrag(screen.getByRole('treeitem'), 'drop', 130)
    expect(active.drop).toHaveBeenCalledWith('after')

    const after = dragProps({ active: true, marker: 'after' })
    rerender(
      <SessionNodeItem node={node} depth={0} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onToggle={vi.fn()} drag={after} />,
    )
    expect(screen.getByRole('treeitem').className).toMatch(/dropAfter/)
  })
})
