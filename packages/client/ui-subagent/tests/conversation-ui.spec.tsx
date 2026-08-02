// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  SessionId, SessionListState, SessionSummary, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  SubagentCatalogAction, type SubagentCatalogActionProps,
} from '../src/client/SubagentCatalogAction.tsx'
import { SubagentReadOnlyComposer } from '../src/client/SubagentReadOnlyComposer.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PARENT = 'parent' as SessionId
const CHILD = 'child' as SessionId
const GRANDCHILD = 'grandchild' as SessionId

function catalog(over: Partial<SubagentCatalogSnapshot> = {}): SubagentCatalogSnapshot {
  return {
    entries: [
      {
        kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
        activity: 'running', hasChildren: true,
      },
      {
        kind: 'child', id: 'child-2' as SessionId, mode: 'one-shot',
        label: 'reviewer', activity: 'inactive', hasChildren: false,
      },
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
  summaries?: Readonly<Record<SessionId, SessionSummary>>,
) {
  const state = {
    ids: [CHILD],
    byId: summaries ?? {
      [CHILD]: {
        id: CHILD,
        title: '正在扫描项目文件',
        displayTitle: 'worker',
        running: true,
        blank: false,
        waitingApproval: false,
        updatedAt: Date.now(),
      },
    },
    current: PARENT, phase: 'ready',
    subagentsByParent: value === undefined ? nested : { [PARENT]: value, ...nested },
    currentAddress: undefined,
  } satisfies SessionListState
  function useSessions<T>(select: (snapshot: SessionListState) => T): T {
    return select(state)
  }
  return {
    sessionId: PARENT,
    useSessions,
    openChild: vi.fn(),
    refresh: vi.fn(),
    setCatalogOpen: vi.fn(),
  } as unknown as SubagentCatalogActionProps
}

function summary(id: SessionId, updatedAt: number): SessionSummary {
  return {
    id,
    displayTitle: id,
    running: false,
    blank: false,
    waitingApproval: false,
    updatedAt,
  }
}

describe('SubagentCatalogAction', () => {
  it('aggregates live descendant activity onto the closed trigger', () => {
    const summaries: Record<SessionId, SessionSummary> = {
      [CHILD]: {
        ...summary(CHILD, Date.now()),
        parentId: PARENT,
        origin: 'subagent',
      },
      [GRANDCHILD]: {
        ...summary(GRANDCHILD, Date.now()),
        parentId: CHILD,
        origin: 'subagent',
        running: true,
      },
      ['child-2' as SessionId]: {
        ...summary('child-2' as SessionId, Date.now()),
        parentId: PARENT,
        origin: 'subagent',
      },
    }
    const view = render(<SubagentCatalogAction {...props(catalog(), {}, summaries)} />)

    const trigger = screen.getByRole('button', { name: '3 个子代理，正在运行' })
    expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()

    view.rerender(<SubagentCatalogAction {...props(catalog(), {}, {
      ...summaries,
      [GRANDCHILD]: { ...summaries[GRANDCHILD]!, running: false },
    })} />)
    expect(screen.getByRole('button', { name: '3 个子代理' })
      .querySelector('[data-state="ongoing"]')).toBeNull()
  })

  it('does not aggregate subagents reached through an ordinary fork', () => {
    const fork = 'fork' as SessionId
    const forkChild = 'fork-child' as SessionId
    render(<SubagentCatalogAction {...props(catalog(), {}, {
      [CHILD]: { ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' },
      ['child-2' as SessionId]: {
        ...summary('child-2' as SessionId, 1), parentId: PARENT, origin: 'subagent',
      },
      [fork]: { ...summary(fork, 1), parentId: PARENT },
      [forkChild]: { ...summary(forkChild, 1), parentId: fork, origin: 'subagent', running: true },
    })} />)

    const trigger = screen.getByRole('button', { name: '2 个子代理' })
    expect(trigger.querySelector('[data-state="ongoing"]')).toBeNull()
  })

  it('renders healthy counts, stable rows, diagnostics, and catalog-addressed navigation', () => {
    const input = props(catalog())
    render(<SubagentCatalogAction {...input} />)
    const trigger = screen.getByRole('button', { name: /2 个子代理/ })
    fireEvent.click(trigger)

    expect(input.setCatalogOpen).toHaveBeenCalledWith(PARENT, true)
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
    expect(screen.getByText('正在扫描项目文件 · 可继续 · 正在运行')).toBeTruthy()
    expect(screen.getByText('一次性 · 当前未运行')).toBeTruthy()
    const diagnostic = screen.getByRole('treeitem', { name: /会话记录损坏/ })
    expect(diagnostic.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: '展开 worker 的下级子代理' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '展开 reviewer 的下级子代理' })).toBeNull()

    fireEvent.click(screen.getByRole('treeitem', { name: /worker/ }))
    expect(input.openChild).toHaveBeenCalledWith({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
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
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /worker/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    await Promise.resolve()
    expect(screen.queryByRole('tree')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('tree'))
    expect(screen.getByRole('tree')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('covers diagnostic variants, fallback labels, and keyboard row activation', () => {
    const unsupported = 'unsupported' as SessionId
    const unavailable = 'unavailable' as SessionId
    const unlabeled = 'unlabeled' as SessionId
    const input = props(catalog({
      entries: [
        { kind: 'diagnostic', id: unsupported, reason: 'unsupported' },
        { kind: 'diagnostic', id: unavailable, reason: 'unavailable' },
        {
          kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
          activity: 'running', hasChildren: false,
        },
        {
          kind: 'child', id: unlabeled, mode: 'one-shot',
          activity: 'inactive', hasChildren: false,
        },
      ],
    }))
    render(<SubagentCatalogAction {...input} />)
    const trigger = screen.getByRole('button', { name: /2 个子代理/ })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.queryByRole('tree')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('treeitem', { name: /子代理记录版本不受支持/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /会话记录暂不可用/ })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('treeitem', { name: /worker/ }), { key: 'Enter' })
    expect(input.openChild).toHaveBeenLastCalledWith({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('treeitem', { name: /unlabeled/ }), { key: ' ' })
    expect(input.openChild).toHaveBeenLastCalledWith({
      parentSessionId: PARENT, childSessionId: unlabeled, mode: 'one-shot',
    })
  })

  it('renders compact activity times across every unit and clamps future timestamps', () => {
    const now = 2_000_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour
    const rows = [
      ['future', now + minute],
      ['minutes', now - 2 * minute],
      ['hours', now - 2 * hour],
      ['days', now - 2 * day],
      ['months', now - 60 * day],
      ['years', now - 2 * 365 * day],
    ] as const
    const entries = rows.map(([id]) => ({
      kind: 'child' as const,
      id: id as SessionId,
      mode: 'continuable' as const,
      label: id,
      activity: 'inactive' as const,
      hasChildren: false,
    }))
    const summaries = Object.fromEntries(rows.map(([id, updatedAt]) => [
      id,
      summary(id as SessionId, updatedAt),
    ])) as Record<SessionId, SessionSummary>
    const input = props(catalog({ entries }), {}, summaries)
    render(<SubagentCatalogAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: /6 个子代理/ }))

    expect(screen.getByRole('treeitem', { name: /future.*刚刚/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /minutes.*2分钟/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /hours.*2小时/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /days.*2天/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /months.*2个月/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /years.*2年/ })).toBeTruthy()
  })

  it('lazily expands and collapses descendant catalogs with direct-parent navigation', () => {
    const childCatalog = catalog({
      entries: [
        {
          kind: 'child', id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'inactive', hasChildren: false,
        },
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
      parentSessionId: CHILD, childSessionId: GRANDCHILD, mode: 'continuable',
    })
    expect(input.setCatalogOpen).toHaveBeenCalledWith(PARENT, false)
    expect(input.setCatalogOpen).toHaveBeenCalledWith(CHILD, false)
  })

  it('shows known descendant rows while their catalog loads', () => {
    const secondGrandchild = 'grandchild-2' as SessionId
    const summaries = {
      [GRANDCHILD]: {
        ...summary(GRANDCHILD, 1), parentId: CHILD, origin: 'subagent' as const,
      },
      [secondGrandchild]: {
        ...summary(secondGrandchild, 1), parentId: CHILD, origin: 'subagent' as const,
        running: true,
      },
    }
    const deferred = props(catalog(), {}, summaries)
    const view = render(<SubagentCatalogAction {...deferred} />)
    fireEvent.click(screen.getByRole('button', { name: /2 个子代理/ }))
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子代理' }))

    expect(deferred.setCatalogOpen).toHaveBeenCalledWith(CHILD, true)
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBe('true')
    const loadingRows = screen.getAllByRole('treeitem', { name: '正在加载子代理' })
    expect(loadingRows).toHaveLength(2)
    expect(loadingRows.every(row => row.getAttribute('aria-level') === '2')).toBe(true)
    expect(loadingRows[1]?.querySelector('[data-state="ongoing"]')).not.toBeNull()

    const loading = props(catalog(), {
      [CHILD]: catalog({ entries: [], state: 'loading' }),
    }, summaries)
    view.rerender(<SubagentCatalogAction {...loading} />)
    expect(screen.getAllByRole('treeitem', { name: '正在加载子代理' })).toHaveLength(2)

    const ready = props(catalog(), {
      [CHILD]: catalog({
        entries: [
          {
            kind: 'child', id: GRANDCHILD, mode: 'continuable',
            label: 'indexer', activity: 'inactive', hasChildren: false,
          },
          {
            kind: 'child', id: secondGrandchild, mode: 'one-shot',
            label: 'critic', activity: 'running', hasChildren: false,
          },
        ],
      }),
    }, summaries)
    view.rerender(<SubagentCatalogAction {...ready} />)
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBeNull()
    expect(screen.getByRole('treeitem', { name: /indexer/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /critic/ })).toBeTruthy()
    expect(screen.queryByRole('treeitem', { name: '正在加载子代理' })).toBeNull()
  })

  it('uses ArrowRight and ArrowLeft for branch disclosure', async () => {
    const input = props(catalog(), {
      [CHILD]: catalog({
        entries: [{
          kind: 'child', id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'running', hasChildren: false,
        }],
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

  it('closes expanded descendants even when their own catalogs have not arrived', () => {
    const input = props(catalog(), {
      [CHILD]: catalog({
        entries: [
          {
            kind: 'child', id: GRANDCHILD, mode: 'continuable',
            label: 'indexer', activity: 'running', hasChildren: true,
          },
          { kind: 'diagnostic', id: 'nested-bad' as SessionId, reason: 'corrupt' },
        ],
      }),
    })
    render(<SubagentCatalogAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: /2 个子代理/ }))
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子代理' }))
    fireEvent.click(screen.getByRole('button', { name: '展开 indexer 的下级子代理' }))
    fireEvent.click(screen.getByRole('button', { name: '收起 worker 的下级子代理' }))

    expect(input.setCatalogOpen).toHaveBeenCalledWith(GRANDCHILD, false)
    expect(input.setCatalogOpen).toHaveBeenCalledWith(CHILD, false)
    expect(screen.queryByRole('treeitem', { name: /indexer/ })).toBeNull()
  })

  it('hides an arrived empty catalog and exposes retry for a failed one', () => {
    const absent = render(<SubagentCatalogAction {...props(undefined)} />)
    expect(screen.queryByRole('button')).toBeNull()
    absent.unmount()

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

  it('renders empty loading and fallback error states without focusable rows', async () => {
    const loading = props(catalog({ entries: [], state: 'loading' }))
    const view = render(<SubagentCatalogAction {...loading} />)
    const trigger = screen.getByRole('button', { name: /0 个子代理/ })
    fireEvent.click(trigger)
    expect(screen.getByText('正在加载子代理…')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await Promise.resolve()
    expect(screen.getByRole('tree')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowUp' })
    view.unmount()

    const failed = props(catalog({ entries: [], state: 'error', error: null }))
    render(<SubagentCatalogAction {...failed} />)
    fireEvent.click(screen.getByRole('button', { name: /0 个子代理/ }))
    expect(screen.getByText('无法加载子代理')).toBeTruthy()
  })

  it('navigates from outside the tree and tolerates a deferred focus after unmount', async () => {
    const input = props(catalog())
    const view = render(<SubagentCatalogAction {...input} />)
    const trigger = screen.getByRole('button', { name: /2 个子代理/ })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    view.unmount()
    await Promise.resolve()
  })

  it('closes every observed catalog when the root becomes empty', () => {
    const populated = props(catalog(), {
      [CHILD]: catalog({
        entries: [{
          kind: 'child', id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'inactive', hasChildren: false,
        }],
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
    render(<SubagentReadOnlyComposer matched={{ reason: 'parent-unavailable' }} />)
    expect(screen.getByRole('status').textContent).toContain('父会话当前不在线')
  })

  it('explains that one-shot histories never accept follow-ups', () => {
    render(<SubagentReadOnlyComposer matched={{ reason: 'one-shot' }} />)
    expect(screen.getByRole('status').textContent).toContain('一次性任务不支持后续消息')
  })
})
