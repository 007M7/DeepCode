import { describe, expect, it } from 'vitest'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { deriveFlat, deriveGroups, formatRelativeTime, projectLabel, UNGROUPED_KEY, UNGROUPED_LABEL } from '../src/client/tree.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, cwd?: string): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, updatedAt, ...(cwd === undefined ? {} : { cwd }),
})
const list = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined,
  phase: 'ready',
  intent: undefined,
})
const workspace = (id: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title: id,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const view = (expandedProjects: readonly string[] = [], query = '') => ({
  expandedProjects, expandedSessions: [] as string[], query,
})

describe('deriveGroups', () => {
  it('keeps Host Workspace and sessionIds order without Client recency sorting', () => {
    const sessions = list(summary('newer', 20), summary('older', 10))
    const workspaces = [workspace('first', ['older', 'newer']), workspace('empty', [])]
    const groups = deriveGroups(sessions, workspaces, view(['first']))
    expect(groups.map(group => group.key)).toEqual(['first', 'empty'])
    expect(groups[0]!.sessions.map(session => session.id)).toEqual([sid('older'), sid('newer')])
  })

  it('puts only real unaccounted Sessions in the trailing Ungrouped group', () => {
    const sessions = list(summary('owned', 1, '/projects/first'), summary('loose', 9, '/other'))
    const groups = deriveGroups(sessions, [workspace('first', ['owned'])], view([UNGROUPED_KEY]))
    expect(groups.map(group => group.key)).toEqual(['first', UNGROUPED_KEY])
    expect(groups[1]!.sessions.map(session => session.id)).toEqual([sid('loose')])
  })

  it('shows one frontend Session row only under a real target Workspace', () => {
    const intent = { sessionId: sid('intent'), target: { kind: 'workspace' as const, workspaceId: wid('first') }, prompt: '', phase: 'connecting' as const }
    const target = workspace('first', [])
    expect(deriveGroups({ ...list(), current: intent.sessionId, intent }, [target], view())[0]).toEqual(expect.objectContaining({
      intentHere: true,
      sessionCount: 1,
      containsCurrent: true,
    }))
    const hiddenIntent = { sessionId: sid('zero'), target: { kind: 'workspace-intent' as const }, prompt: '', phase: 'ready' as const }
    expect(deriveGroups({ ...list(), intent: hiddenIntent }, [target], view())[0]!.intentHere).toBe(false)
  })

  it('an Intent no longer forces its target group expanded (viewer owns expansion)', () => {
    const intent = { sessionId: sid('intent'), target: { kind: 'workspace' as const, workspaceId: wid('first') }, prompt: '', phase: 'connecting' as const }
    const groups = deriveGroups({ ...list(), intent }, [workspace('first', [])], view())
    expect(groups[0]).toEqual(expect.objectContaining({ intentHere: true, expanded: false }))
  })

  it('search filters real Sessions and omits the Intent placeholder', () => {
    const intent = { sessionId: sid('intent'), target: { kind: 'workspace' as const, workspaceId: wid('first') }, prompt: '', phase: 'ready' as const }
    const groups = deriveGroups({ ...list(summary('match', 1)), intent }, [workspace('first', ['match'])], view([], 'match'))
    expect(groups[0]!.sessions.map(session => session.id)).toEqual([sid('match')])
    expect(groups[0]!.intentHere).toBe(false)
    expect(groups[0]!.sessionCount).toBe(2)
  })

  it('builds, sorts, expands, and cycle-guards an ungrouped session tree', () => {
    const parent = summary('parent', 1)
    const oldChild = { ...summary('old-child', 10), parentId: parent.id }
    const newChild = { ...summary('new-child', 20), parentId: parent.id }
    const tieB = { ...summary('tie-b', 20), parentId: parent.id }
    const tieA = { ...summary('tie-a', 20), parentId: parent.id }
    const self = { ...summary('self', 2), parentId: sid('self') }
    const orphan = { ...summary('orphan', 3), parentId: sid('missing') }
    const cycleA = { ...summary('cycle-a', 4), parentId: sid('cycle-b') }
    const cycleB = { ...summary('cycle-b', 5), parentId: sid('cycle-a') }
    const groups = deriveGroups(
      list(parent, oldChild, newChild, tieB, tieA, self, orphan, cycleA, cycleB),
      [],
      { expandedProjects: [UNGROUPED_KEY], expandedSessions: [parent.id, cycleA.id, cycleB.id], query: '' },
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]!.sessions.map(node => node.id)).toEqual([
      sid('orphan'), sid('self'), parent.id, sid('cycle-a'),
    ])
    expect(groups[0]!.sessions[2]!.children.map(node => node.id)).toEqual([
      newChild.id, tieA.id, tieB.id, oldChild.id,
    ])

    // Equal timestamps use ids as a deterministic tiebreak in either input order.
    expect(deriveGroups(list(summary('tie-a', 1), summary('tie-b', 1)), [], view([UNGROUPED_KEY]))[0]!
      .sessions.map(node => node.id)).toEqual([sid('tie-a'), sid('tie-b')])
  })

  it('tolerates Workspace membership arriving before its Session summary', () => {
    const partial: SessionListState = {
      ...list(),
      ids: [sid('present')],
      byId: { [sid('present')]: summary('present', 1) },
    }
    const groups = deriveGroups(partial, [workspace('project', ['missing', 'present'])], view(['project']))
    expect(groups[0]!.sessions.map(node => node.id)).toEqual([sid('present')])
  })

  it('searches descendants with ancestors and handles cycles, self parents, and label-only hits', () => {
    const root = { ...summary('root', 1), displayTitle: 'Ancestor' }
    const match = { ...summary('match', 2), displayTitle: 'Needle child', parentId: root.id }
    const sibling = { ...summary('sibling', 3), displayTitle: 'Other child', parentId: root.id }
    const self = { ...summary('self', 4), displayTitle: 'Needle self', parentId: sid('self') }
    const orphan = { ...summary('orphan', 5), displayTitle: 'Needle orphan', parentId: sid('absent') }
    const cycleA = { ...summary('cycle-a', 6), displayTitle: 'Needle cycle A', parentId: sid('cycle-b') }
    const cycleB = { ...summary('cycle-b', 7), displayTitle: 'Needle cycle B', parentId: sid('cycle-a') }
    const sessions = list(root, match, sibling, self, orphan, cycleA, cycleB)
    const groups = deriveGroups(sessions, [workspace('project', sessions.ids)], view([], 'needle'))

    expect(groups[0]!.sessions.flatMap(node => [node.id, ...node.children.map(child => child.id)])).toEqual([
      root.id, match.id, self.id, orphan.id, cycleA.id, cycleB.id,
    ])

    const labelOnly = deriveGroups(
      list(summary('hidden', 1)),
      [workspace('label-hit', ['hidden']), workspace('other', [])],
      view([], 'label'),
    )
    expect(labelOnly).toEqual([
      expect.objectContaining({ key: 'label-hit', expanded: false, sessions: [], sessionCount: 1 }),
    ])
  })

  it('marks selected Workspace and Ungrouped sessions without relying on an Intent', () => {
    const owned = summary('owned', 1)
    const loose = summary('loose', 2)
    const ws = workspace('project', ['owned'])
    const ownedGroups = deriveGroups({ ...list(owned, loose), current: owned.id }, [ws], view())
    expect(ownedGroups.find(group => group.key === 'project')!.containsCurrent).toBe(true)
    const looseGroups = deriveGroups({ ...list(owned, loose), current: loose.id }, [ws], view())
    expect(looseGroups.find(group => group.key === UNGROUPED_KEY)!.containsCurrent).toBe(true)
  })
})

describe('deriveFlat', () => {
  it('flattens every session — fork children included — newest-first with id tiebreak', () => {
    const parent = summary('parent', 10)
    const child = { ...summary('child', 30), parentId: parent.id }
    const tieB = summary('tie-b', 20)
    const tieA = summary('tie-a', 20)
    const rows = deriveFlat(list(parent, child, tieB, tieA), { query: '' })
    expect(rows.map(row => row.id)).toEqual([sid('child'), sid('tie-a'), sid('tie-b'), sid('parent')])
    // Rows are branch-free: no children, no expansion.
    expect(rows.every(row => row.children.length === 0 && !row.hasChildren && !row.expanded)).toBe(true)
  })

  it('search filters by case-insensitive display-title substring', () => {
    const hit = { ...summary('hit', 2), displayTitle: 'Needle row' }
    const miss = { ...summary('miss', 1), displayTitle: 'Other' }
    expect(deriveFlat(list(hit, miss), { query: ' NEEDLE ' }).map(row => row.id)).toEqual([sid('hit')])
  })

  it('tolerates ids whose summary has not landed yet', () => {
    const partial: SessionListState = { ...list(summary('present', 1)), ids: [sid('ghost'), sid('present')] }
    expect(deriveFlat(partial, { query: '' }).map(row => row.id)).toEqual([sid('present')])
  })
})

describe('createWorkspaceViewStore', () => {
  it('defaults to workspace grouping; setGroupBy is the sole mutation', () => {
    const store = createWorkspaceViewStore().create()
    expect(store.getSnapshot().groupBy).toBe('workspace')
    store.actions.setGroupBy('flat')
    expect(store.getSnapshot().groupBy).toBe('flat')
  })
})

describe('projectLabel', () => {
  it('uses the Ungrouped fallback and extracts POSIX and Windows basenames', () => {
    expect(projectLabel(undefined)).toBe(UNGROUPED_LABEL)
    expect(projectLabel('')).toBe(UNGROUPED_LABEL)
    expect(projectLabel('/projects/demo/')).toBe('demo')
    expect(projectLabel('C:\\projects\\demo\\')).toBe('demo')
    expect(projectLabel('/')).toBe('/')
  })
})

describe('formatRelativeTime', () => {
  it('formats current, minute, hour, day, month, and year buckets', () => {
    const now = 400 * 24 * 60 * 60 * 1_000
    expect(formatRelativeTime(now, now)).toBe('now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5min')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d')
    expect(formatRelativeTime(now - 60 * 86_400_000, now)).toBe('2mo')
    expect(formatRelativeTime(0, now)).toBe('1y')
  })
})
