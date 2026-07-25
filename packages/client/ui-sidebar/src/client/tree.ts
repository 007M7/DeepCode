/**
 * Pure sidebar tree derivation: session list snapshot -> flat render rows.
 * Groups sessions by project directory (cwd), builds the per-group session
 * tree from parentId links, sorts by recency, and applies search filtering
 * with forced ancestor visibility. Derived data is a pure function (slot
 * design section 6): the component feeds the useSessions snapshot plus its
 * local viewing state through useMemo — no materializing store.
 */
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'

/** Group key for sessions without a project directory. */
export const UNGROUPED_KEY = ''

/** Display label for the ungrouped project row. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** Project (workspace) row: 54px, two lines (label + session count). */
export interface ProjectRow {
  type: 'project'
  /** Group key: the cwd, or {@link UNGROUPED_KEY}. */
  key: string
  cwd: string | undefined
  label: string
  /** Total sessions in the group, including hidden ones. */
  sessionCount: number
  expanded: boolean
}

/** Session row: 34px single line; depth drives the 22px indent steps. */
export interface SessionRow {
  type: 'session'
  id: SessionId
  /** Owning project group key (selection -> active-folder lookup). */
  groupKey: string
  title: string
  /** 0 = directly under the project row. */
  depth: number
  hasChildren: boolean
  expanded: boolean
  running: boolean
  updatedAt: number
}

/** One flat sidebar list row. */
export type SidebarRow = ProjectRow | SessionRow

/** Viewing state consumed by the derivation — the component's local useState arrays, taken as-is. */
export interface TreeView {
  expandedProjects: readonly string[]
  expandedSessions: readonly string[]
  query: string
}

interface Group {
  key: string
  cwd: string | undefined
  label: string
  summaries: Map<SessionId, SessionSummary>
  roots: SessionId[]
  children: Map<SessionId, SessionId[]>
  latest: number
}

/**
 * Project display label: basename of the group directory.
 * @param cwd - project directory, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or the ungrouped label.
 */
export function projectLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return UNGROUPED_LABEL
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base !== '' ? base : cwd
}

/** Recency comparator: newest first, id as the deterministic tiebreak (ids are unique per group). */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

function groupByCwd(list: SessionListState): Group[] {
  const byKey = new Map<string, SessionSummary[]>()
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined) continue
    const key = s.cwd ?? UNGROUPED_KEY
    const members = byKey.get(key)
    if (members === undefined) byKey.set(key, [s])
    else members.push(s)
  }
  const groups: Group[] = []
  for (const [key, members] of byKey) {
    const summaries = new Map(members.map(m => [m.id, m]))
    const children = new Map<SessionId, SessionId[]>()
    const roots: SessionSummary[] = []
    for (const m of members) {
      // A session is a tree child only when its parent lives in the same
      // group; cross-group or unknown parents degrade to group roots.
      if (m.parentId !== undefined && m.parentId !== m.id && summaries.has(m.parentId)) {
        const kids = children.get(m.parentId)
        if (kids === undefined) children.set(m.parentId, [m.id])
        else kids.push(m.id)
      } else {
        roots.push(m)
      }
    }
    roots.sort(byRecency)
    for (const kids of children.values()) {
      kids.sort((a, b) => {
        const sa = summaries.get(a)
        const sb = summaries.get(b)
        /* v8 ignore next -- unreachable: kid ids are inserted alongside their summaries. */
        if (sa === undefined || sb === undefined) return 0
        return byRecency(sa, sb)
      })
    }
    const rootIds = roots.map(r => r.id)
    // parentId cycles (host bug) leave members unreachable from any root;
    // surface them as extra roots — the flatten walk's visited set stops
    // loops. Each node sits in at most one kids list and roots have no
    // in-group parent, so the scan pushes every reachable node exactly once.
    const reachable = new Set<SessionId>(rootIds)
    const stack = [...rootIds]
    while (stack.length > 0) {
      const top = stack.pop()
      /* v8 ignore next -- unreachable: the loop condition guarantees a non-empty stack. */
      if (top === undefined) break
      for (const kid of children.get(top) ?? []) {
        reachable.add(kid)
        stack.push(kid)
      }
    }
    for (const m of [...members].sort(byRecency)) {
      if (!reachable.has(m.id)) rootIds.push(m.id)
    }
    let latest = 0
    for (const m of members) latest = Math.max(latest, m.updatedAt)
    groups.push({
      key,
      cwd: key === UNGROUPED_KEY ? undefined : key,
      label: projectLabel(key === UNGROUPED_KEY ? undefined : key),
      summaries,
      roots: rootIds,
      children,
      latest,
    })
  }
  groups.sort((a, b) => b.latest - a.latest || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  return groups
}

function sessionRow(g: Group, s: SessionSummary, depth: number, hasChildren: boolean, expanded: boolean): SessionRow {
  return {
    type: 'session',
    id: s.id,
    groupKey: g.key,
    title: s.displayTitle,
    depth,
    hasChildren,
    expanded,
    running: s.running,
    updatedAt: s.updatedAt,
  }
}

function flattenVisible(g: Group, expandedSessions: ReadonlySet<string>, rows: SidebarRow[]): void {
  const visited = new Set<SessionId>()
  const walk = (id: SessionId, depth: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    const s = g.summaries.get(id)
    /* v8 ignore next -- unreachable: walked ids come from the grouped summaries. */
    if (s === undefined) return
    const kids = g.children.get(id) ?? []
    const expanded = expandedSessions.has(id)
    rows.push(sessionRow(g, s, depth, kids.length > 0, expanded))
    if (expanded) for (const kid of kids) walk(kid, depth + 1)
  }
  for (const root of g.roots) walk(root, 0)
}

/** Matched sessions plus their ancestor chains (forced visible under search). */
function searchVisible(g: Group, q: string): Set<SessionId> {
  const visible = new Set<SessionId>()
  for (const m of g.summaries.values()) {
    if (!m.displayTitle.toLowerCase().includes(q)) continue
    let cur: SessionSummary | undefined = m
    while (cur !== undefined && !visible.has(cur.id)) {
      visible.add(cur.id)
      cur = cur.parentId !== undefined && cur.parentId !== cur.id ? g.summaries.get(cur.parentId) : undefined
    }
  }
  return visible
}

function flattenSearch(g: Group, visible: ReadonlySet<SessionId>, rows: SidebarRow[]): void {
  const visited = new Set<SessionId>()
  const walk = (id: SessionId, depth: number): void => {
    if (visited.has(id) || !visible.has(id)) return
    visited.add(id)
    const s = g.summaries.get(id)
    /* v8 ignore next -- unreachable: walked ids come from the grouped summaries. */
    if (s === undefined) return
    const kids = (g.children.get(id) ?? []).filter(kid => visible.has(kid))
    rows.push(sessionRow(g, s, depth, kids.length > 0, kids.length > 0))
    for (const kid of kids) walk(kid, depth + 1)
  }
  for (const root of g.roots) walk(root, 0)
}

/**
 * Derive the flat sidebar row list.
 *
 * Normal mode: every project row shows; sessions show under expanded
 * projects, descending only into expanded sessions. Search mode (non-blank
 * query, case-insensitive display-title substring): expansion state is ignored —
 * matched sessions and their ancestor chains are forced visible, groups
 * without a display-title or label hit are dropped, and a label-only hit keeps the
 * bare project row.
 * @param list - sessions list snapshot.
 * @param view - local expansion arrays and search query.
 * @returns rows in render order.
 */
export function deriveRows(list: SessionListState, view: TreeView): SidebarRow[] {
  const q = view.query.trim().toLowerCase()
  const expandedProjects = new Set(view.expandedProjects)
  const expandedSessions = new Set(view.expandedSessions)
  const rows: SidebarRow[] = []
  for (const g of groupByCwd(list)) {
    if (q === '') {
      const expanded = expandedProjects.has(g.key)
      rows.push({ type: 'project', key: g.key, cwd: g.cwd, label: g.label, sessionCount: g.summaries.size, expanded })
      if (expanded) flattenVisible(g, expandedSessions, rows)
    } else {
      const visible = searchVisible(g, q)
      if (visible.size === 0 && !g.label.toLowerCase().includes(q)) continue
      rows.push({
        type: 'project',
        key: g.key,
        cwd: g.cwd,
        label: g.label,
        sessionCount: g.summaries.size,
        expanded: visible.size > 0,
      })
      flattenSearch(g, visible, rows)
    }
  }
  return rows
}

/**
 * Relative time label for session rows (figma samples: now / 2min / 1h / 2d / 18d / 2mo).
 * @param updatedAt - epoch ms of the last update.
 * @param now - current epoch ms.
 * @returns compact age label.
 */
export function formatRelativeTime(updatedAt: number, now: number): string {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}min`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d`
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo`
  return `${Math.floor(diff / (365 * DAY))}y`
}
