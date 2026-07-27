// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  SessionId, SessionListState, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  SubagentCatalogAction, type SubagentCatalogActionProps,
} from '../src/client/SubagentCatalogAction.tsx'
import { SubagentReadOnlyComposer } from '../src/client/SubagentReadOnlyComposer.tsx'

afterEach(cleanup)

const PARENT = 'parent' as SessionId
const CHILD = 'child' as SessionId
const GRANDCHILD = 'grandchild' as SessionId

function catalog(over: Partial<SubagentCatalogSnapshot> = {}): SubagentCatalogSnapshot {
  return {
    entries: [
      { kind: 'child', id: CHILD, label: 'worker', activity: 'running' },
      { kind: 'child', id: 'child-2' as SessionId, label: 'reviewer', activity: 'inactive' },
      { kind: 'diagnostic', id: 'bad' as SessionId, reason: 'corrupt' },
    ],
    parentAvailable: true,
    state: 'ready',
    error: null,
    ...over,
  }
}

function props(
  value: SubagentCatalogSnapshot | undefined,
  nested: Readonly<Record<SessionId, SubagentCatalogSnapshot>> = {},
) {
  const state = {
    ids: [CHILD],
    byId: {
      [CHILD]: {
        id: CHILD,
        title: '正在扫描项目文件',
        displayTitle: 'worker',
        running: true,
        blank: false,
        updatedAt: Date.now(),
      },
    },
    current: PARENT, phase: 'ready',
    subagentsByParent: value === undefined ? nested : { [PARENT]: value, ...nested },
    currentAddress: undefined,
  } satisfies SessionListState
  return {
    sessionId: PARENT,
    useSessions: (<T,>(select: (snapshot: SessionListState) => T) => select(state)),
    openChild: vi.fn(),
    refresh: vi.fn(),
    setCatalogOpen: vi.fn(),
  } as unknown as SubagentCatalogActionProps
}

describe('SubagentCatalogAction', () => {
  it('renders healthy counts, stable rows, diagnostics, and catalog-addressed navigation', () => {
    const input = props(catalog())
    render(<SubagentCatalogAction {...input} />)
    const trigger = screen.getByRole('button', { name: /2 个子代理/ })
    fireEvent.click(trigger)

    expect(input.setCatalogOpen).toHaveBeenCalledWith(PARENT, true)
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
    expect(screen.getByText('正在扫描项目文件')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    const diagnostic = screen.getByRole('treeitem', { name: /会话记录损坏/ })
    expect(diagnostic.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(screen.getByRole('treeitem', { name: /worker/ }))
    expect(input.openChild).toHaveBeenCalledWith({
      parentSessionId: PARENT, childSessionId: CHILD,
    })
    expect(input.setCatalogOpen).toHaveBeenLastCalledWith(PARENT, false)
  })

  it('supports trigger/menu keyboard traversal, Escape focus restore, and outside close', async () => {
    const input = props(catalog())
    render(<SubagentCatalogAction {...input} />)
    const trigger = screen.getByRole('button', { name: /2 个子代理/ })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await Promise.resolve()
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /worker/ }))

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    await Promise.resolve()
    expect(screen.queryByRole('tree')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('lazily expands and collapses descendant catalogs with direct-parent navigation', () => {
    const childCatalog = catalog({
      entries: [
        { kind: 'child', id: GRANDCHILD, label: 'indexer', activity: 'inactive' },
      ],
    })
    const grandchildCatalog = catalog({ entries: [] })
    const input = props(catalog(), {
      [CHILD]: childCatalog,
      [GRANDCHILD]: grandchildCatalog,
    })
    render(<SubagentCatalogAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: /2 个子代理/ }))

    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子代理' }))
    expect(input.setCatalogOpen).toHaveBeenCalledWith(CHILD, true)
    const nested = screen.getByRole('treeitem', { name: /indexer/ })
    expect(nested.getAttribute('aria-level')).toBe('2')

    fireEvent.click(nested)
    expect(input.openChild).toHaveBeenCalledWith({
      parentSessionId: CHILD, childSessionId: GRANDCHILD,
    })
    expect(input.setCatalogOpen).toHaveBeenCalledWith(PARENT, false)
    expect(input.setCatalogOpen).toHaveBeenCalledWith(CHILD, false)
  })

  it('uses ArrowRight and ArrowLeft for branch disclosure', async () => {
    const input = props(catalog(), {
      [CHILD]: catalog({
        entries: [{ kind: 'child', id: GRANDCHILD, label: 'indexer', activity: 'running' }],
      }),
    })
    render(<SubagentCatalogAction {...input} />)
    const trigger = screen.getByRole('button', { name: /2 个子代理/ })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await Promise.resolve()
    const worker = screen.getByRole('treeitem', { name: /worker/ })
    fireEvent.keyDown(worker, { key: 'ArrowRight' })
    expect(screen.getByRole('treeitem', { name: /indexer/ })).toBeTruthy()
    fireEvent.keyDown(worker, { key: 'ArrowLeft' })
    expect(screen.queryByRole('treeitem', { name: /indexer/ })).toBeNull()
    expect(input.setCatalogOpen).toHaveBeenCalledWith(CHILD, false)
  })

  it('hides an arrived empty catalog and exposes retry for a failed one', () => {
    const empty = props(catalog({ entries: [] }))
    const view = render(<SubagentCatalogAction {...empty} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.unmount()

    const failed = props(catalog({
      entries: [],
      state: 'error',
      error: { code: 'internal', message: 'index down', details: {} },
    }))
    render(<SubagentCatalogAction {...failed} />)
    fireEvent.click(screen.getByRole('button', { name: /0 个子代理/ }))
    expect(screen.getByText('index down')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(failed.refresh).toHaveBeenCalledWith(PARENT)
  })

  it('closes every observed catalog when the root becomes empty', () => {
    const populated = props(catalog(), {
      [CHILD]: catalog({
        entries: [{ kind: 'child', id: GRANDCHILD, label: 'indexer', activity: 'inactive' }],
      }),
    })
    const view = render(<SubagentCatalogAction {...populated} />)
    fireEvent.click(screen.getByRole('button', { name: /2 个子代理/ }))
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子代理' }))

    const empty = props(catalog({ entries: [] }))
    view.rerender(<SubagentCatalogAction {...empty} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(empty.setCatalogOpen).toHaveBeenCalledWith(PARENT, false)
    expect(empty.setCatalogOpen).toHaveBeenCalledWith(CHILD, false)
  })
})

describe('SubagentReadOnlyComposer', () => {
  it('explains the exact missing-parent recovery path', () => {
    render(<SubagentReadOnlyComposer />)
    expect(screen.getByRole('status').textContent).toContain('父会话当前不在线')
  })
})
