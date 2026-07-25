/**
 * Derives the sidebar tree from Host Workspace order and membership.
 * Unassigned Sessions trail under Ungrouped; only Intents targeting real Workspaces render.
 */
import type { SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/** Display label for the ungrouped bucket row. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** One session node of a group's visible tree (34px row; children render indented one step). */
export interface SessionNode {
  id: SessionId
  title: string
  /** Visible children, already expansion/search-filtered (empty when folded). */
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
  /** Total sessions in the group, including hidden ones. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** The frontend Session Intent points here: render one "New session" row. */
  intentHere: boolean
  /** Visible roots (empty while the group is folded). */
  sessions: readonly SessionNode[]
}

/** Viewing state consumed by the derivation — the component's local useState arrays, taken as-is. */
export interface TreeView {
  expandedProjects: readonly string[]
  expandedSessions: readonly string[]
  query: string
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
      members.push(summary)
      accounted.add(id)
    }
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path, workspace.title, members, 'account',
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary => s !== undefined && !accounted.has(s.id))
  if (stray.length > 0) {
    groups.push(buildGroup(UNGROUPED_KEY, undefined, undefined, UNGROUPED_LABEL, stray, 'recency'))
  }
  return groups
}

function sessionNode(s: SessionSummary, children: readonly SessionNode[], hasChildren: boolean, expanded: boolean): SessionNode {
  return {
    id: s.id,
    title: s.displayTitle,
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

function buildSearch(g: Group, visible: ReadonlySet<SessionId>): SessionNode[] {
  const visited = new Set<SessionId>()
  const walk = (id: SessionId): SessionNode | null => {
    if (visited.has(id) || !visible.has(id)) return null
    visited.add(id)
    const s = g.summaries.get(id)
    /* v8 ignore next -- unreachable: walked ids come from the grouped summaries. */
    if (s === undefined) return null
    const kids = (g.children.get(id) ?? []).filter(kid => visible.has(kid))
    const children = kids.map(walk).filter((n): n is SessionNode => n !== null)
    return sessionNode(s, children, kids.length > 0, kids.length > 0)
  }
  return g.roots.map(walk).filter((n): n is SessionNode => n !== null)
}

/**
 * Derive the nested sidebar group structure.
 *
 * Normal mode: every group shows; sessions populate under expanded groups,
 * descending only into expanded sessions. A frontend Session Intent targeting
 * a real Workspace marks that group `intentHere` and forces it expanded. Search mode (non-blank query,
 * case-insensitive display-title substring): expansion state is ignored —
 * matched sessions and their ancestor chains are forced visible, groups
 * without a display-title or label hit are dropped, a label-only hit keeps
 * the bare group header, and Intent rows do not participate.
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real workspaces in stable Host order.
 * @param view - local expansion arrays and search query.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  view: TreeView,
): GroupNode[] {
  const q = view.query.trim().toLowerCase()
  const expandedProjects = new Set(view.expandedProjects)
  const expandedSessions = new Set(view.expandedSessions)
  const intent = list.intent
  const intentWorkspaceId = intent?.target.kind === 'workspace'
    ? intent.target.workspaceId
    : undefined
  const currentAccount = list.current === undefined
    ? undefined
    : workspaces.find(w => w.sessionIds.includes(list.current as SessionId))?.workspaceId as string | undefined
  const currentGroup = list.current === undefined
    ? undefined
    : intent?.sessionId === list.current
      ? intentWorkspaceId
      : currentAccount ?? UNGROUPED_KEY
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces)) {
    const hasIntent = intentWorkspaceId !== undefined
      && g.workspaceId !== undefined && intentWorkspaceId === g.workspaceId
    const intentHere = q === '' && hasIntent
    if (q === '') {
      const expanded = intentHere || expandedProjects.has(g.key)
      groups.push({
        key: g.key,
        workspaceId: g.workspaceId,
        cwd: g.cwd,
        label: g.label,
        sessionCount: g.summaries.size + (hasIntent ? 1 : 0),
        expanded,
        containsCurrent: g.key === currentGroup,
        intentHere,
        sessions: expanded ? buildVisible(g, expandedSessions) : [],
      })
    } else {
      const visible = searchVisible(g, q)
      if (visible.size === 0 && !g.label.toLowerCase().includes(q)) continue
      groups.push({
        key: g.key,
        workspaceId: g.workspaceId,
        cwd: g.cwd,
        label: g.label,
        sessionCount: g.summaries.size + (hasIntent ? 1 : 0),
        expanded: visible.size > 0,
        containsCurrent: g.key === currentGroup,
        intentHere: false,
        sessions: buildSearch(g, visible),
      })
    }
  }
  return groups
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
