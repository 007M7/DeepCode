/**
 * Sidebar tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only.
 */
import clsx from 'clsx'
import {
  IconFolderClose16, IconFolderOpen16, IconPlusOutline16,
  IconTriangleRightFill14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GroupNode, SessionNode } from './tree.ts'
import { formatRelativeTime } from './tree.ts'
import css from './Rows.module.css'

/** Indent step per tree level: one 16px slot (figma session cell). */
const INDENT_STEP = 16

/**
 * Project (workspace) header row: 54px, folder + title + session count;
 * hover reveals the chevron and create button. `containsCurrent` arrives on
 * the node (derivation fact, no renderer scan).
 * @param props.group - derived group node.
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - start a frontend Session inside this Workspace.
 * @returns the row element.
 */
export function ProjectRowItem({ group, onToggle, onCreate }: {
  group: GroupNode
  onToggle: () => void
  onCreate: () => void
}) {
  const row = group
  const active = group.expanded && group.containsCurrent
  const count = `${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'}`
  return (
    <div className={css.projectRow} role="treeitem" aria-expanded={row.expanded} onClick={onToggle}>
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
 * @returns the placeholder row element.
 */
export function IntentRowItem() {
  return (
    <div className={clsx(css.sessionRow, css.selected)} role="treeitem" aria-selected style={{ paddingLeft: 8 }}>
      <span className={css.slot} />
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
export function SessionNodeItem({ node, depth, currentId, now, onOpen, onToggle }: {
  node: SessionNode
  depth: number
  currentId: string | undefined
  now: number
  onOpen: (id: SessionNode['id']) => void
  onToggle: (id: SessionNode['id']) => void
}) {
  const row = node
  const selected = node.id === currentId
  // Rail (figma session cell: pad 8, twist slot 16, status slot 16, gap 4 to
  // the title): both slots are always reserved so titles align whether or not
  // the twist/dot is lit. Extra depth rides the left padding.
  const ownRow = (
    <div
      className={clsx(css.sessionRow, selected && css.selected)}
      role="treeitem"
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      style={{ paddingLeft: 8 + depth * INDENT_STEP }}
      onClick={() => { onOpen(node.id) }}
    >
      {row.hasChildren
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
        : <span className={css.slot} />}
      <span className={css.slot}>{row.running && <StateDot state="ongoing" />}</span>
      <span className={css.title}>{row.title}</span>
      <span className={css.time}>{formatRelativeTime(row.updatedAt, now)}</span>
    </div>
  )
  return (
    <>
      {ownRow}
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
