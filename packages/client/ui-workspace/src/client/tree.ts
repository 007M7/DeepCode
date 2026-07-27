/**
 * Derives the workspace browser tree from Host Workspace order and membership.
 * Unassigned Sessions trail under Ungrouped; only the selected blank Session
 * remains visible.
 */
import type {
  SessionId, SessionListState, SessionSearchResultItem, SessionSummary, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/** Display label for the ungrouped bucket row. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** One session node of a group's visible tree (34px row; children render indented one step). */
export interface SessionNode {
  id: SessionId
  title: string
  /** Visible children, already expansion-filtered (empty when folded). */
  children: readonly SessionNode[]
  /** The session HAS children in the data (the twist renders even while folded). */
  hasChildren: boolean
  expanded: boolean
  running: boolean
  updatedAt: number
}

/** One workspace group section: header row facts + the visible session tree. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  label: string
  /** Total visible sessions in the group. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** Visible roots (empty while the group is folded). */
  sessions: readonly SessionNode[]
}

/** One flat search row combining list metadata with an optional content match. */
export interface SearchResultNode {
  id: SessionId
  title: string
  workspace: string
  running: boolean
  snippet?: string
}

/** Bounded merged search projection plus the refine-query hint bit. */
export interface SearchResultSet {
  items: readonly SearchResultNode[]
  hasMore: boolean
}

/** Viewing state consumed by the derivation — the component's local useState arrays, taken as-is. */
export interface TreeView {
  expandedProjects: readonly string[]
  expandedSessions: readonly string[]
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  label: string
  summaries: Map<SessionId, SessionSummary>
  roots: SessionId[]
  children: Map<SessionId, SessionId[]>
}

/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
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

/** Ordinary sessions are visible; among blank sessions, only the current one is visible. */
function sessionVisible(session: SessionSummary, current: SessionId | undefined): boolean {
  return !session.blank || session.id === current
}

/** A blank session is the selected Workspace's provisional New Session row. */
function sessionTitle(session: SessionSummary): string {
  return session.blank ? 'New Session' : session.displayTitle
}

/** Build one group's parent/child tree from an ordered member list. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  label: string,
  members: readonly SessionSummary[],
  order: 'account' | 'recency',
): Group {
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
  // Workspace order is the member iteration order (workspace.sessionIds), so
  // attached groups keep insertion order; Ungrouped sorts by recency.
  if (order === 'recency') {
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
  for (const m of members) {
    if (!reachable.has(m.id)) rootIds.push(m.id)
  }
  return { key, workspaceId, cwd, label, summaries, roots: rootIds, children }
}

/**
 * Group Sessions by Host Workspace: one group per entity in stable Host
 * order, with members resolved from sessionIds in their stored order. Sessions
 * outside every Workspace trail in the recency-ordered Ungrouped bucket.
 */
function groupByWorkspace(list: SessionListState, workspaces: readonly WorkspaceView[]): Group[] {
  const groups: Group[] = []
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    const members: SessionSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
      accounted.add(id)
      if (!sessionVisible(summary, list.current)) continue
      members.push(summary)
    }
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path, workspace.title, members, 'account',
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && sessionVisible(s, list.current))
  if (stray.length > 0) {
    groups.push(buildGroup(UNGROUPED_KEY, undefined, undefined, UNGROUPED_LABEL, stray, 'recency'))
  }
  return groups
}

function sessionNode(s: SessionSummary, children: readonly SessionNode[], hasChildren: boolean, expanded: boolean): SessionNode {
  return {
    id: s.id,
    title: sessionTitle(s),
    children,
    hasChildren,
    expanded,
    running: s.running,
    updatedAt: s.updatedAt,
  }
}

function buildVisible(g: Group, expandedSessions: ReadonlySet<string>): SessionNode[] {
  const visited = new Set<SessionId>()
  const walk = (id: SessionId): SessionNode | null => {
    if (visited.has(id)) return null
    visited.add(id)
    const s = g.summaries.get(id)
    /* v8 ignore next -- unreachable: walked ids come from the grouped summaries. */
    if (s === undefined) return null
    const kids = g.children.get(id) ?? []
    const expanded = expandedSessions.has(id)
    const children = expanded ? kids.map(walk).filter((n): n is SessionNode => n !== null) : []
    return sessionNode(s, children, kids.length > 0, expanded)
  }
  return g.roots.map(walk).filter((n): n is SessionNode => n !== null)
}

/**
 * Derive the nested workspace browser group structure.
 *
 * Every group shows; sessions populate under expanded groups, descending
 * only into expanded sessions. Blank sessions are excluded except for the
 * selected provisional New Session row.
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real workspaces in stable Host order.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  view: TreeView,
): GroupNode[] {
  const expandedProjects = new Set(view.expandedProjects)
  const expandedSessions = new Set(view.expandedSessions)
  const currentGroup = list.current === undefined
    ? undefined
    : (workspaces.find(w => w.sessionIds.includes(list.current as SessionId))?.workspaceId as string | undefined)
        ?? UNGROUPED_KEY
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces)) {
    const expanded = expandedProjects.has(g.key)
    groups.push({
      key: g.key,
      workspaceId: g.workspaceId,
      cwd: g.cwd,
      label: g.label,
      sessionCount: g.summaries.size,
      expanded,
      containsCurrent: g.key === currentGroup,
      sessions: expanded ? buildVisible(g, expandedSessions) : [],
    })
  }
  return groups
}

/**
 * Derive the flat session list ("In one list" mode): every session — fork
 * children included — as a top-level row, strictly newest-first. No grouping,
 * no parent/child adjacency; rows reuse SessionNode with children always
 * empty so the renderer stays branch-free.
 * @param list - sessions list snapshot.
 * @returns flat rows in render order.
 */
export function deriveFlat(list: SessionListState): SessionNode[] {
  const rows: SessionSummary[] = []
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined || !sessionVisible(s, list.current)) continue
    rows.push(s)
  }
  rows.sort(byRecency)
  return rows.map(s => sessionNode(s, [], false, false))
}

/**
 * Merge immediate title/Workspace substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], hasMore: false }

  const workspaceBySession = new Map<SessionId, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title)
    }
  }
  const labelOf = (summary: SessionSummary): string =>
    workspaceBySession.get(summary.id) ?? projectLabel(summary.cwd)
  const contentBySession = new Map<SessionId, SessionSearchResultItem>()
  for (const item of content.items) {
    if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item)
  }

  const local: SessionSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined || !sessionVisible(summary, list.current)) continue
    if (
      sessionTitle(summary).toLowerCase().includes(q)
      || labelOf(summary).toLowerCase().includes(q)
    ) {
      local.push(summary)
    }
  }
  local.sort(byRecency)

  const ordered: SessionSummary[] = []
  const included = new Set<SessionId>()
  const include = (summary: SessionSummary): void => {
    if (included.has(summary.id)) return
    included.add(summary.id)
    ordered.push(summary)
  }
  for (const summary of local) include(summary)
  for (const item of content.items) {
    const summary = list.byId[item.sessionId]
    if (summary !== undefined && sessionVisible(summary, list.current)) include(summary)
  }

  return {
    items: ordered.slice(0, limit).map((summary) => {
      const match = contentBySession.get(summary.id)
      return {
        id: summary.id,
        title: sessionTitle(summary),
        workspace: labelOf(summary),
        running: summary.running,
        ...match === undefined ? {} : { snippet: match.snippet },
      }
    }),
    hasMore: content.hasMore || ordered.length > limit,
  }
}

/**
 * Compact relative time for session rows ("now", "5min", "3h", "2d", "4mo", "1y").
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the row's trailing time label.
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
