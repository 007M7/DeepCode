/**
 * Sidebar tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only.
 */
import clsx from 'clsx'
import {
  IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16,
  IconTriangleRightFill14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectRow, SessionRow } from './tree.ts'
import { formatRelativeTime } from './tree.ts'
import css from './Rows.module.css'

/** Indent step per tree level: one 16px slot (figma session cell). */
const INDENT_STEP = 16

/**
 * Project (workspace) row: 54px, folder + title + session count; hover
 * reveals the chevron and the more/create buttons.
 * @param props.row - derived project row.
 * @param props.active - group contains the selected session (blue open folder).
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - create a session inside this group.
 * @returns the row element.
 */
export function ProjectRowItem({ row, active, onToggle, onCreate }: {
  row: ProjectRow
  active: boolean
  onToggle: () => void
  onCreate: () => void
}) {
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
        {/* Row menu contents are not designed yet (figma draft notes); the button is the reserved anchor. */}
        <button type="button" className={css.iconButton} aria-label="More" onClick={(e) => { e.stopPropagation() }}>
          <IconEllipsisOutline16 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label="New session here"
          onClick={(e) => { e.stopPropagation(); onCreate() }}
        >
          <IconPlusOutline16 />
        </button>
      </span>
    </div>
  )
}

/**
 * Session row: 34px, indent by depth, expand twist when it has children,
 * running state dot, relative time swapping to the more button on hover.
 * @param props.row - derived session row.
 * @param props.selected - row is the current session.
 * @param props.now - epoch ms for relative-time formatting.
 * @param props.onOpen - open this session.
 * @param props.onToggle - unfold/fold the subtree.
 * @returns the row element.
 */
export function SessionRowItem({ row, selected, now, onOpen, onToggle }: {
  row: SessionRow
  selected: boolean
  now: number
  onOpen: () => void
  onToggle: () => void
}) {
  // Rail (figma session cell: pad 8, twist slot 16, status slot 16, gap 4 to
  // the title): both slots are always reserved so titles align whether or not
  // the twist/dot is lit. Extra depth rides the left padding.
  return (
    <div
      className={clsx(css.sessionRow, selected && css.selected)}
      role="treeitem"
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      style={{ paddingLeft: 8 + row.depth * INDENT_STEP }}
      onClick={onOpen}
    >
      {row.hasChildren
        ? (
            <button
              type="button"
              className={css.twist}
              aria-label={row.expanded ? 'Collapse' : 'Expand'}
              onClick={(e) => { e.stopPropagation(); onToggle() }}
            >
              <IconTriangleRightFill14 className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
            </button>
          )
        : <span className={css.slot} />}
      <span className={css.slot}>{row.running && <StateDot state="ongoing" />}</span>
      <span className={css.title}>{row.title}</span>
      <span className={css.time}>{formatRelativeTime(row.updatedAt, now)}</span>
      <span className={css.rowActions}>
        <button type="button" className={css.iconButton} aria-label="More" onClick={(e) => { e.stopPropagation() }}>
          <IconEllipsisOutline16 />
        </button>
      </span>
    </div>
  )
}
