/**
 * Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only. Row ... menus are visual-only
 * except workspace Rename/Delete and session Rename/Fork; the session and
 * workspace hover cards are suppressed while a menu is open.
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  HoverCard, IconBranchOutline16, IconEditOutline16, IconEllipsisOutline16,
  IconFolderClose16, IconFolderOpen16, IconPlusOutline16,
  IconTrashOutline16, IconTriangleRightFill14, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GroupNode, SessionNode } from '../tree.ts'
import { formatRelativeTime } from '../tree.ts'
import css from './Rows.module.css'

const SESSION_MENU_ITEMS = [
  { id: 'rename', label: 'Rename', icon: <IconEditOutline16 /> },
  { id: 'fork', label: 'Fork session', icon: <IconBranchOutline16 /> },
  { id: 'delete', label: 'Delete session', icon: <IconTrashOutline16 />, danger: true },
]

const WORKSPACE_MENU_ITEMS = [
  { id: 'rename', label: 'Rename', icon: <IconEditOutline16 /> },
  { id: 'delete', label: 'Delete workspace', icon: <IconTrashOutline16 />, danger: true },
]

/** Hover-card body: workspace title, full directory path, absolute creation time. */
function WorkspaceHoverContent({ label, cwd, createdAt }: {
  label: string
  cwd: string | undefined
  createdAt: number
}) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{label}</div>
      <div className={css.hoverPath}>{cwd}</div>
      <div className={css.hoverTime}>{`Created ${new Date(createdAt).toLocaleString()}`}</div>
    </div>
  )
}

/**
 * Project (workspace) header row: 54px, folder + title + session count;
 * hover reveals the chevron and create button, and dwelling on a real
 * Workspace shows its hover card (the ungrouped bucket has none).
 * `containsCurrent` arrives on the node (derivation fact, no renderer scan).
 * @param props.group - derived group node.
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - start a frontend Session inside this Workspace.
 * @returns the row element.
 */
export function ProjectRowItem({ group, onToggle, onCreate, actions }: {
  group: GroupNode
  onToggle: () => void
  onCreate: () => void
  /** Real-Workspace actions; absent for the ungrouped bucket (no menu shown). */
  actions?: { rename: () => void; delete: () => void } | undefined
}) {
  const row = group
  const active = group.expanded && group.containsCurrent
  const count = `${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'}`
  const [menuOpen, setMenuOpen] = useState(false)
  const ownRow = (
    <div
      className={clsx(css.projectRow, menuOpen && css.menuOpen)}
      role="treeitem"
      aria-expanded={row.expanded}
      onClick={onToggle}
    >
      <span className={clsx(css.slot, css.folder, active && css.folderActive)}>
        {row.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={clsx(css.slot, css.chevron)}>
        <IconTriangleRightFill14 className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
      </span>
      <span className={css.projectText}>
        <span className={css.title}>{row.label}</span>
        <span className={css.meta}>{count}</span>
      </span>
      <span className={css.rowActions}>
        {actions !== undefined && (
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={WORKSPACE_MENU_ITEMS}
            onSelect={(id) => {
              setMenuOpen(false)
              // Unknown ids leave before the dispatch: a future menu row must
              // not inherit the destructive branch as an else fallback.
              /* v8 ignore next -- WORKSPACE_MENU_ITEMS carries exactly these two rows today. */
              if (id !== 'rename' && id !== 'delete') return
              if (id === 'rename') actions.rename()
              else actions.delete()
            }}
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={`Workspace actions for ${row.label}`}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={`New session in ${row.label}`}
          onClick={(e) => { e.stopPropagation(); onCreate() }}
        >
          <IconPlusOutline16 />
        </button>
      </span>
    </div>
  )
  // The ungrouped bucket has no backing Workspace: no card to show.
  if (row.createdAt === undefined) return ownRow
  return (
    <HoverCard
      anchor={ownRow}
      content={<WorkspaceHoverContent label={row.label} cwd={row.cwd} createdAt={row.createdAt} />}
      disabled={menuOpen}
    />
  )
}

/**
 * One top-level 34px session row with running dot and relative time.
 * @param props.node - derived session node.
 * @param props.currentId - selected session id (row highlight).
 * @param props.now - epoch ms for relative-time formatting.
 * @param props.onOpen - open a session by id.
 * @returns the session row.
 */
/** Hover-card body: full title, relative time, and the status line (running/idle until wire status lands). */
function SessionHoverContent({ node, now }: { node: SessionNode; now: number }) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{node.title}</div>
      <div className={css.hoverTime}>{`${formatRelativeTime(node.updatedAt, now)} ago`}</div>
      <div className={css.hoverStatus}>
        <StateDot state={node.running ? 'ongoing' : 'done'} />
        <span>{node.running ? 'Running' : 'Idle'}</span>
      </div>
    </div>
  )
}

/**
 * Session-row drag wiring supplied by the group owner (workspace groups only).
 * `drop` reports the half of the row the pointer released on: 'before'
 * inserts above this row, 'after' below it (the owner resolves the anchor).
 */
export interface RowDragProps {
  /** Start dragging this row. */
  start: () => void
  /** A drag from the same group is in flight (rows show insert markers). */
  active: boolean
  /** Current marker on this row: insert line above, below, or none. */
  marker: 'before' | 'after' | null
  /** Report the hovered half while a same-group drag passes over this row. */
  hover: (half: 'before' | 'after') => void
  drop: (half: 'before' | 'after') => void
  end: () => void
}

/** Pointer-position half of a row (insert line above or below). */
function rowHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

export function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, drag }: {
  node: SessionNode
  currentId: string | undefined
  now: number
  onOpen: (id: SessionNode['id']) => void
  /** Open the browser-owned session rename dialog (row menu action). */
  onRename: (id: SessionNode['id'], currentTitle: string) => void
  /** Fork a session at its last completed turn (row menu action). */
  onFork: (id: SessionNode['id']) => void
  /** Present only on draggable rows (workspace-group sessions outside search). */
  drag?: RowDragProps | undefined
}) {
  const row = node
  const selected = node.id === currentId
  const [menuOpen, setMenuOpen] = useState(false)
  // Figma session cell: pad 8, status slot 16, then a 4px title gap.
  const ownRow = (
    <div
      className={clsx(
        css.sessionRow, selected && css.selected, menuOpen && css.menuOpen,
        drag?.marker === 'before' && css.dropBefore, drag?.marker === 'after' && css.dropAfter,
      )}
      role="treeitem"
      aria-selected={selected}
      onClick={() => { onOpen(node.id) }}
      draggable={drag !== undefined}
      onDragStart={drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          drag.start()
        }}
      onDragEnd={drag?.end}
      onDragOver={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          drag.hover(rowHalf(e))
        }}
      onDrop={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          drag.drop(rowHalf(e))
        }}
    >
      <span className={css.slot}>{row.running && <StateDot state="ongoing" />}</span>
      <span className={css.title}>{row.title}</span>
      <span className={css.time}>{formatRelativeTime(row.updatedAt, now)}</span>
      <span className={css.rowActions}>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={SESSION_MENU_ITEMS}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'rename') onRename(node.id, row.title)
            if (id === 'fork') onFork(node.id) // delete stays visual-only.
          }}
          portal
          closeOnPointerLeave
          anchor={(
            <button
              type="button"
              className={css.iconButton}
              aria-label={`Session actions for ${row.title}`}
              onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
            >
              <IconEllipsisOutline16 />
            </button>
          )}
        />
      </span>
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      content={<SessionHoverContent node={node} now={now} />}
      disabled={menuOpen || drag?.active === true}
    />
  )
}
