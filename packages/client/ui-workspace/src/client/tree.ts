/**
 * Derives the workspace browser tree from Host Workspace order and membership.
 * Unassigned Sessions trail under Ungrouped; only the selected blank Session
 * remains visible.
 */
import type { SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/** Display label for the ungrouped bucket row. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  title: string
  running: boolean
  updatedAt: number
}

/** One workspace group section: header row facts + visible top-level session rows. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  /** Workspace creation time (epoch ms); absent only for the ungrouped bucket. */
  createdAt: number | undefined
  label: string
  /** Total visible sessions in the group. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** Visible session rows (empty while the group is folded). */
  sessions: readonly SessionNode[]
}

/** Viewing state consumed by the derivation. */
export interface TreeView {
  expandedProjects: readonly string[]
  query: string
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessions: SessionSummary[]
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

/** Build one group without projecting session lineage into presentation. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  createdAt: number | undefined,
  label: string,
  members: readonly SessionSummary[],
  order: 'account' | 'recency',
): Group {
  const sessions = [...members]
  // Workspace order is workspace.sessionIds; only Ungrouped lacks an account
  // order and therefore falls back to recency.
  if (order === 'recency') sessions.sort(byRecency)
  return { key, workspaceId, cwd, createdAt, label, sessions }
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
      workspace.workspaceId, workspace.workspaceId, workspace.path,
      Date.parse(workspace.createdAt), workspace.title, members, 'account',
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && sessionVisible(s, list.current))
  if (stray.length > 0) {
    groups.push(buildGroup(UNGROUPED_KEY, undefined, undefined, undefined, UNGROUPED_LABEL, stray, 'recency'))
  }
  return groups
}

function sessionNode(s: SessionSummary): SessionNode {
  return {
    id: s.id,
    title: sessionTitle(s),
    running: s.running,
    updatedAt: s.updatedAt,
  }
}

/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Normal mode: every group shows; sessions populate under expanded groups,
 * preserving Host account order. Search mode (non-blank query,
 * case-insensitive display-title substring): expansion state is ignored —
 * matching sessions are forced visible, groups without a display-title or
 * label hit are dropped, and a label-only hit
 * keeps the bare group header. Non-current blank sessions are excluded.
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
  const currentGroup = list.current === undefined
    ? undefined
    : (workspaces.find(w => w.sessionIds.includes(list.current as SessionId))?.workspaceId as string | undefined)
        ?? UNGROUPED_KEY
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces)) {
    if (q === '') {
      const expanded = expandedProjects.has(g.key)
      groups.push({
        key: g.key,
        workspaceId: g.workspaceId,
        cwd: g.cwd,
        createdAt: g.createdAt,
        label: g.label,
        sessionCount: g.sessions.length,
        expanded,
        containsCurrent: g.key === currentGroup,
        sessions: expanded ? g.sessions.map(sessionNode) : [],
      })
    } else {
      const matches = g.sessions.filter(session => sessionTitle(session).toLowerCase().includes(q))
      if (matches.length === 0 && !g.label.toLowerCase().includes(q)) continue
      groups.push({
        key: g.key,
        workspaceId: g.workspaceId,
        cwd: g.cwd,
        createdAt: g.createdAt,
        label: g.label,
        sessionCount: g.sessions.length,
        expanded: matches.length > 0,
        containsCurrent: g.key === currentGroup,
        sessions: matches.map(sessionNode),
      })
    }
  }
  return groups
}

/**
 * Derive the flat session list ("In one list" mode): every session — fork
 * children included — as a top-level row, strictly newest-first. No grouping,
 * no parent/child adjacency. Search mode filters by case-insensitive
 * display-title substring.
 * @param list - sessions list snapshot.
 * @param view - the search query (expansion state does not apply).
 * @returns flat rows in render order.
 */
export function deriveFlat(list: SessionListState, view: Pick<TreeView, 'query'>): SessionNode[] {
  const q = view.query.trim().toLowerCase()
  const rows: SessionSummary[] = []
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined || !sessionVisible(s, list.current)) continue
    if (q !== '' && !sessionTitle(s).toLowerCase().includes(q)) continue
    rows.push(s)
  }
  rows.sort(byRecency)
  return rows.map(sessionNode)
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
