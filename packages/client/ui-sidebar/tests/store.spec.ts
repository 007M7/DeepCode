import { describe, expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { createSidebarTreeStore } from '@deepseek-ai/dsh-client-ui-sidebar/client'

const sid = (s: string) => s as SessionId

/** Bare-string init; brands ids and omits absent optional keys (exactOptionalPropertyTypes). */
interface SummaryInit {
  id: string
  title?: string
  cwd?: string
  parentId?: string
  running?: boolean
  updatedAt?: number
}

function summary(init: SummaryInit): SessionSummary {
  const s: SessionSummary = {
    id: sid(init.id),
    title: init.title ?? init.id,
    running: init.running ?? false,
    updatedAt: init.updatedAt ?? 0,
  }
  if (init.cwd !== undefined) s.cwd = init.cwd
  if (init.parentId !== undefined) s.parentId = sid(init.parentId)
  return s
}

function listStateOf(...summaries: SessionSummary[]): SessionListState {
  const byId: Record<SessionId, SessionSummary> = {}
  for (const s of summaries) byId[s.id] = s
  return { ids: summaries.map(s => s.id), byId }
}

function setup(...summaries: SessionSummary[]) {
  const list = createSnapshotStore<SessionListState>(listStateOf(...summaries))
  const tree = createSidebarTreeStore({ list })
  return { list, tree }
}

const flushMicrotasks = () => new Promise<void>((resolve) => { queueMicrotask(resolve) })

describe('createSidebarTreeStore', () => {
  it('materializes rows from the initial list snapshot', () => {
    const { tree } = setup(summary({ id: 'a', cwd: '/p' }))
    expect(tree.store.getSnapshot().rows).toEqual([
      expect.objectContaining({ type: 'project', key: '/p', sessionCount: 1 }),
    ])
  })

  it('re-derives when the sessions list changes', async () => {
    const { list, tree } = setup(summary({ id: 'a', cwd: '/p' }))
    list.update((draft) => {
      draft.ids.push(sid('b'))
      draft.byId[sid('b')] = summary({ id: 'b', cwd: '/q', updatedAt: 99 })
    })
    // Snapshot-store notifications are microtask-batched.
    await flushMicrotasks()
    expect(tree.store.getSnapshot().rows.map(r => r.type === 'project' && r.key)).toEqual(['/q', '/p'])
  })

  it('toggleProject expands and collapses synchronously', () => {
    const { tree } = setup(summary({ id: 'a', cwd: '/p' }))
    tree.toggleProject('/p')
    expect(tree.store.getSnapshot().rows).toHaveLength(2)
    tree.toggleProject('/p')
    expect(tree.store.getSnapshot().rows).toHaveLength(1)
  })

  it('toggleSession unfolds a subtree', () => {
    const { tree } = setup(
      summary({ id: 'root', cwd: '/p', updatedAt: 2 }),
      summary({ id: 'kid', cwd: '/p', parentId: sid('root'), updatedAt: 1 }),
    )
    tree.toggleProject('/p')
    expect(tree.store.getSnapshot().rows).toHaveLength(2)
    tree.toggleSession(sid('root'))
    expect(tree.store.getSnapshot().rows).toHaveLength(3)
  })

  it('setQuery switches into search mode and back', () => {
    const { tree } = setup(
      summary({ id: 'a', title: 'needle', cwd: '/p' }),
      summary({ id: 'b', title: 'other', cwd: '/q' }),
    )
    tree.setQuery('needle')
    const rows = tree.store.getSnapshot().rows
    expect(rows.map(r => r.type)).toEqual(['project', 'session'])
    tree.setQuery('')
    expect(tree.store.getSnapshot().rows.every(r => r.type === 'project')).toBe(true)
  })

  it('setGroupBy records the strategy and re-derives', () => {
    const { tree } = setup(summary({ id: 'a', cwd: '/p' }))
    tree.setGroupBy('workspace')
    expect(tree.store.getSnapshot().groupBy).toBe('workspace')
    expect(tree.store.getSnapshot().rows).toHaveLength(1)
  })

  it('dispose stops re-derivation on list changes', async () => {
    const { list, tree } = setup(summary({ id: 'a', cwd: '/p' }))
    tree.dispose()
    list.update((draft) => {
      draft.ids.push(sid('b'))
      draft.byId[sid('b')] = summary({ id: 'b', cwd: '/q' })
    })
    await flushMicrotasks()
    expect(tree.store.getSnapshot().rows).toHaveLength(1)
  })
})
