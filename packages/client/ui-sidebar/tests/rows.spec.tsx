// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { IntentRowItem, ProjectRowItem, SessionNodeItem } from '../src/client/Rows.tsx'
import type { GroupNode, SessionNode } from '../src/client/tree.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

describe('sidebar rows', () => {
  it('renders an active Workspace and keeps its create action separate from toggling', () => {
    const onToggle = vi.fn()
    const onCreate = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', label: 'Project',
      sessionCount: 1, expanded: true, containsCurrent: true, intentHere: false, sessions: [],
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

  it('renders the frontend Intent placeholder as selected', () => {
    render(<IntentRowItem />)
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('true')
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
      <SessionNodeItem node={parent} depth={0} currentId={parent.id} now={0} onOpen={onOpen} onToggle={onToggle} />,
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
        depth={1} currentId={undefined} now={0} onOpen={onOpen} onToggle={onToggle}
      />,
    )
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy()
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('treeitem').style.paddingLeft).toBe('24px')
  })
})
