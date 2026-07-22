import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import {
  deriveRows, formatRelativeTime, projectLabel, UNGROUPED_KEY, UNGROUPED_LABEL,
  type SessionRow, type TreeView,
} from '../src/client/tree.ts'

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

function listOf(...summaries: SessionSummary[]): SessionListState {
  const byId: Record<SessionId, SessionSummary> = {}
  for (const s of summaries) byId[s.id] = s
  return { ids: summaries.map(s => s.id), byId, current: undefined }
}

const view = (partial: Partial<TreeView> = {}): TreeView => ({
  expandedProjects: partial.expandedProjects ?? [],
  expandedSessions: partial.expandedSessions ?? [],
  query: partial.query ?? '',
})

describe('projectLabel', () => {
  it('takes the basename and survives trailing separators', () => {
    expect(projectLabel('/home/me/proj')).toBe('proj')
    expect(projectLabel('/home/me/proj/')).toBe('proj')
    expect(projectLabel('C:\\work\\thing')).toBe('thing')
  })

  it('falls back for empty and root-only paths', () => {
    expect(projectLabel(undefined)).toBe(UNGROUPED_LABEL)
    expect(projectLabel('')).toBe(UNGROUPED_LABEL)
    expect(projectLabel('///')).toBe('///')
  })
})

describe('deriveRows grouping', () => {
  it('groups by cwd into project rows with counts, newest group first', () => {
    const rows = deriveRows(listOf(
      summary({ id: 'a', cwd: '/x/alpha', updatedAt: 10 }),
      summary({ id: 'b', cwd: '/x/beta', updatedAt: 30 }),
      summary({ id: 'c', cwd: '/x/alpha', updatedAt: 20 }),
    ), view())
    expect(rows).toEqual([
      expect.objectContaining({ type: 'project', key: '/x/beta', label: 'beta', sessionCount: 1, expanded: false }),
      expect.objectContaining({ type: 'project', key: '/x/alpha', label: 'alpha', sessionCount: 2 }),
    ])
  })

  it('orders equally-recent groups by label and skips ids missing from byId', () => {
    const list = listOf(
      summary({ id: 'b1', cwd: '/x/beta', updatedAt: 5 }),
      summary({ id: 'a1', cwd: '/x/alpha', updatedAt: 5 }),
      // Same basename and same recency as beta: label comparator returns 0,
      // insertion order breaks the tie.
      summary({ id: 'b2', cwd: '/y/beta', updatedAt: 5 }),
    )
    list.ids.push(sid('ghost'))
    const rows = deriveRows(list, view())
    expect(rows.map(r => r.type === 'project' && r.key)).toEqual(['/x/alpha', '/x/beta', '/y/beta'])
  })

  it('buckets cwd-less sessions under the ungrouped project row', () => {
    const rows = deriveRows(listOf(summary({ id: 'a' })), view())
    expect(rows).toEqual([
      expect.objectContaining({ type: 'project', key: UNGROUPED_KEY, cwd: undefined, label: UNGROUPED_LABEL }),
    ])
  })

  it('hides sessions under collapsed projects and shows them when expanded', () => {
    const list = listOf(
      summary({ id: 'a', cwd: '/p', updatedAt: 1 }),
      summary({ id: 'b', cwd: '/p', updatedAt: 2 }),
    )
    expect(deriveRows(list, view()).filter(r => r.type === 'session')).toHaveLength(0)
    const rows = deriveRows(list, view({ expandedProjects: ['/p'] }))
    expect(rows.slice(1)).toEqual([
      expect.objectContaining({ type: 'session', id: 'b', depth: 0 }),
      expect.objectContaining({ type: 'session', id: 'a', depth: 0 }),
    ])
  })
})

describe('deriveRows session tree', () => {
  const treeList = listOf(
    summary({ id: 'root', cwd: '/p', updatedAt: 5 }),
    summary({ id: 'kid', cwd: '/p', parentId: sid('root'), updatedAt: 4 }),
    summary({ id: 'grandkid', cwd: '/p', parentId: sid('kid'), updatedAt: 3 }),
    summary({ id: 'other', cwd: '/p', updatedAt: 9 }),
  )

  it('nests children under expanded parents with increasing depth', () => {
    const rows = deriveRows(treeList, view({
      expandedProjects: ['/p'],
      expandedSessions: ['root', 'kid'],
    }))
    expect(rows.slice(1)).toEqual([
      expect.objectContaining({ id: 'other', depth: 0, hasChildren: false }),
      expect.objectContaining({ id: 'root', depth: 0, hasChildren: true, expanded: true }),
      expect.objectContaining({ id: 'kid', depth: 1, hasChildren: true, expanded: true }),
      expect.objectContaining({ id: 'grandkid', depth: 2, hasChildren: false }),
    ])
  })

  it('collapses subtrees at unexpanded sessions', () => {
    const rows = deriveRows(treeList, view({ expandedProjects: ['/p'] }))
    const ids = rows.filter((r): r is SessionRow => r.type === 'session').map(r => r.id)
    expect(ids).toEqual(['other', 'root'])
  })

  it('degrades a cross-group parent link to a group root', () => {
    const rows = deriveRows(listOf(
      summary({ id: 'p1', cwd: '/a', updatedAt: 2 }),
      summary({ id: 'stray', cwd: '/b', parentId: sid('p1'), updatedAt: 1 }),
    ), view({ expandedProjects: ['/a', '/b'] }))
    expect(rows).toEqual([
      expect.objectContaining({ type: 'project', key: '/a' }),
      expect.objectContaining({ id: 'p1', depth: 0 }),
      expect.objectContaining({ type: 'project', key: '/b' }),
      expect.objectContaining({ id: 'stray', depth: 0 }),
    ])
  })

  it('keeps cycle members visible as extra roots without looping', () => {
    const rows = deriveRows(listOf(
      summary({ id: 'x', cwd: '/p', parentId: sid('y'), updatedAt: 2 }),
      summary({ id: 'y', cwd: '/p', parentId: sid('x'), updatedAt: 1 }),
      summary({ id: 'self', cwd: '/p', parentId: sid('self'), updatedAt: 3 }),
    ), view({ expandedProjects: ['/p'], expandedSessions: ['x', 'y', 'self'] }))
    const ids = rows.filter((r): r is SessionRow => r.type === 'session').map(r => r.id)
    expect(ids).toContain('self')
    expect(ids).toContain('x')
    expect(ids).toContain('y')
    expect(ids).toHaveLength(3)
  })

  it('breaks updatedAt ties deterministically by id', () => {
    const rows = deriveRows(listOf(
      summary({ id: 'b', cwd: '/p', updatedAt: 7 }),
      summary({ id: 'a', cwd: '/p', updatedAt: 7 }),
      summary({ id: 'c', cwd: '/p', updatedAt: 7 }),
    ), view({ expandedProjects: ['/p'] }))
    const ids = rows.filter((r): r is SessionRow => r.type === 'session').map(r => r.id)
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('collects multiple children under one parent in recency order', () => {
    const rows = deriveRows(listOf(
      summary({ id: 'p', cwd: '/p', updatedAt: 9 }),
      summary({ id: 'old', cwd: '/p', parentId: sid('p'), updatedAt: 1 }),
      summary({ id: 'new', cwd: '/p', parentId: sid('p'), updatedAt: 5 }),
    ), view({ expandedProjects: ['/p'], expandedSessions: ['p'] }))
    const ids = rows.filter((r): r is SessionRow => r.type === 'session').map(r => r.id)
    expect(ids).toEqual(['p', 'new', 'old'])
  })

  it('carries the running flag onto rows', () => {
    const rows = deriveRows(
      listOf(summary({ id: 'a', cwd: '/p', running: true })),
      view({ expandedProjects: ['/p'] }))
    expect(rows[1]).toEqual(expect.objectContaining({ id: 'a', running: true }))
  })
})

describe('deriveRows search', () => {
  const list = listOf(
    summary({ id: 'root', title: 'alpha work', cwd: '/p', updatedAt: 5 }),
    summary({ id: 'kid', title: 'deep needle here', cwd: '/p', parentId: sid('root'), updatedAt: 4 }),
    summary({ id: 'noise', title: 'unrelated', cwd: '/p', updatedAt: 3 }),
    summary({ id: 'q', title: 'quiet', cwd: '/other', updatedAt: 2 }),
  )

  it('forces matched sessions and their ancestor chains visible, ignoring expansion', () => {
    const rows = deriveRows(list, view({ query: 'NEEDLE' }))
    expect(rows).toEqual([
      expect.objectContaining({ type: 'project', key: '/p', expanded: true }),
      expect.objectContaining({ id: 'root', depth: 0, expanded: true }),
      expect.objectContaining({ id: 'kid', depth: 1 }),
    ])
  })

  it('drops groups without a hit and keeps a bare project row on label-only hits', () => {
    const rows = deriveRows(list, view({ query: 'other' }))
    expect(rows).toEqual([
      expect.objectContaining({ type: 'project', key: '/other', expanded: false }),
    ])
  })

  it('blank query means normal mode', () => {
    const rows = deriveRows(list, view({ query: '   ' }))
    expect(rows.every(r => r.type === 'project')).toBe(true)
  })
})

describe('formatRelativeTime', () => {
  const now = 1_000_000_000_000
  it.each([
    [now, 'now'],
    [now - 30_000, 'now'],
    [now - 2 * 60_000, '2min'],
    [now - 3_600_000, '1h'],
    [now - 2 * 86_400_000, '2d'],
    [now - 18 * 86_400_000, '18d'],
    [now - 65 * 86_400_000, '2mo'],
    [now - 400 * 86_400_000, '1y'],
  ])('%d -> %s', (at, label) => {
    expect(formatRelativeTime(at, now)).toBe(label)
  })

  it('clamps future timestamps to now', () => {
    expect(formatRelativeTime(now + 5_000, now)).toBe('now')
  })
})
