import { describe, expect, it } from 'vitest'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { deriveGroups, formatRelativeTime, UNGROUPED_KEY } from '../src/client/tree.ts'

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

  it('search filters real Sessions and omits the Intent placeholder', () => {
    const intent = { sessionId: sid('intent'), target: { kind: 'workspace' as const, workspaceId: wid('first') }, prompt: '', phase: 'ready' as const }
    const groups = deriveGroups({ ...list(summary('match', 1)), intent }, [workspace('first', ['match'])], view([], 'match'))
    expect(groups[0]!.sessions.map(session => session.id)).toEqual([sid('match')])
    expect(groups[0]!.intentHere).toBe(false)
    expect(groups[0]!.sessionCount).toBe(2)
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
