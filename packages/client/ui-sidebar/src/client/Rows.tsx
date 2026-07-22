/**
 * Sidebar tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only.
 */
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconChevronRightOutline14,
  IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16,
  IconTreeCorner8x10, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectRow, SessionRow } from './tree.ts'
import { formatRelativeTime } from './tree.ts'
import css from './Rows.module.css'

/** Indent step per tree level: 16px slot + 6px gap (figma). */
const INDENT_STEP = 22

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
        {row.expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
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
  // Rail (figma sub-cell slot sequence): twist slot, always-reserved state
  // slot (opacity-0 slots keep their 22px in figma, so titles align whether
  // or not the dot is lit), then the L connector on child rows. Extra depth
  // rides the left padding: indent spacers = depth - 1.
  return (
    <div
      className={clsx(css.sessionRow, selected && css.selected)}
      role="treeitem"
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      style={{ paddingLeft: 8 + Math.max(0, row.depth - 1) * INDENT_STEP }}
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
              {row.expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
            </button>
          )
        : <span className={css.slot} />}
      <span className={css.slot}>{row.running && <StateDot state="ongoing" />}</span>
      {row.depth > 0 && (
        <span className={css.cornerSlot} data-tree-corner="">
          <IconTreeCorner8x10 />
        </span>
      )}
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
