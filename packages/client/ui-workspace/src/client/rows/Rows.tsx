/**
 * Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only. Row ... menus are visual-only
 * except workspace Rename; the session hover card is suppressed while a menu
 * is open.
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

/** Indent step per tree level: one 16px slot (figma session cell). */
const INDENT_STEP = 16

const SESSION_MENU_ITEMS = [
  { id: 'rename', label: 'Rename', icon: <IconEditOutline16 /> },
  { id: 'fork', label: 'Fork session', icon: <IconBranchOutline16 /> },
  { id: 'delete', label: 'Delete session', icon: <IconTrashOutline16 />, danger: true },
]

const WORKSPACE_MENU_ITEMS = [
  { id: 'rename', label: 'Rename', icon: <IconEditOutline16 /> },
  { id: 'delete', label: 'Delete workspace', icon: <IconTrashOutline16 />, danger: true },
]

/**
 * Project (workspace) header row: 54px, folder + title + session count;
 * hover reveals the chevron and create button. `containsCurrent` arrives on
 * the node (derivation fact, no renderer scan).
 * @param props.group - derived group node.
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - start a frontend Session inside this Workspace.
 * @returns the row element.
 */
export function ProjectRowItem({ group, onToggle, onCreate, onRename }: {
  group: GroupNode
  onToggle: () => void
  onCreate: () => void
  /** Open the rename dialog; absent for the ungrouped bucket (no menu shown). */
  onRename?: (() => void) | undefined
}) {
  const row = group
  const active = group.expanded && group.containsCurrent
  const count = `${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'}`
  const [menuOpen, setMenuOpen] = useState(false)
  return (
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
        {onRename !== undefined && (
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={WORKSPACE_MENU_ITEMS}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'rename') onRename()
              // Delete is visual-only for now.
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
}

/**
 * The selected "New session" row for a frontend Session Intent targeted to a
 * real Workspace. The row disappears when the Intent is replaced or connects.
 * One status-slot indent in both grouped and flat lists (session rows carry
 * no twist slot either, so titles align).
 * @returns the placeholder row element.
 */
export function IntentRowItem() {
  return (
    <div className={clsx(css.sessionRow, css.selected)} role="treeitem" aria-selected style={{ paddingLeft: 8 }}>
      <span className={css.slot} />
      <span className={css.title}>New session</span>
    </div>
  )
}

/**
 * One session subtree: the node's own 34px row (indent by depth, expand
 * twist when it has children, running dot, relative time) plus its visible
 * children, recursively — the component tree mirrors the derived tree.
 * @param props.node - derived session node.
 * @param props.depth - 0 = directly under the group header.
 * @param props.currentId - selected session id (row highlight).
 * @param props.now - epoch ms for relative-time formatting.
 * @param props.onOpen - open a session by id.
 * @param props.onToggle - unfold/fold a subtree by id.
 * @returns the node's row followed by its children.
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
 * Root-row drag wiring supplied by the group owner (workspace groups only).
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

export function SessionNodeItem({ node, depth, currentId, now, onOpen, onToggle, drag, flat = false }: {
  node: SessionNode
  depth: number
  currentId: string | undefined
  now: number
  onOpen: (id: SessionNode['id']) => void
  onToggle: (id: SessionNode['id']) => void
  /** Present only on draggable rows (workspace-group roots outside search). */
  drag?: RowDragProps | undefined
  /** Flat-list variant: no twist slot (figma flat cell) — titles align on the status slot. */
  flat?: boolean
}) {
  const row = node
  const selected = node.id === currentId
  const [menuOpen, setMenuOpen] = useState(false)
  // Rail (figma session cell: pad 8, twist slot 16, status slot 16, gap 4 to
  // the title): both slots are always reserved so titles align whether or not
  // the twist/dot is lit. Extra depth rides the left padding.
  const ownRow = (
    <div
      className={clsx(
        css.sessionRow, selected && css.selected, menuOpen && css.menuOpen,
        drag?.marker === 'before' && css.dropBefore, drag?.marker === 'after' && css.dropAfter,
      )}
      role="treeitem"
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      style={{ paddingLeft: 8 + depth * INDENT_STEP }}
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
      {row.hasChildren && !flat
        ? (
            <button
              type="button"
              className={css.twist}
              aria-label={row.expanded ? 'Collapse' : 'Expand'}
              onClick={(e) => { e.stopPropagation(); onToggle(node.id) }}
            >
              <IconTriangleRightFill14 className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
            </button>
          )
        : null}
      <span className={css.slot}>{row.running && <StateDot state="ongoing" />}</span>
      <span className={css.title}>{row.title}</span>
      <span className={css.time}>{formatRelativeTime(row.updatedAt, now)}</span>
      <span className={css.rowActions}>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={SESSION_MENU_ITEMS}
          onSelect={() => { setMenuOpen(false) }} // Visual-only for now.
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
    <>
      <HoverCard
        anchor={ownRow}
        content={<SessionHoverContent node={node} now={now} />}
        disabled={menuOpen || drag?.active === true}
      />
      {node.children.map(child => (
        <SessionNodeItem
          key={child.id}
          node={child}
          depth={depth + 1}
          currentId={currentId}
          now={now}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      ))}
    </>
  )
}
