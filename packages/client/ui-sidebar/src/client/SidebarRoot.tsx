/**
 * SidebarRoot (figma 133:7629): logo row + collapse, New Session, search,
 * WorkSpace section header with the group-by menu, session tree list,
 * Settings foot. Pure presentational — data and actions arrive through the
 * inject surface; the tree store is subscribed via useTree, never derived in
 * render.
 */
import { Fragment, useState } from 'react'
import clsx from 'clsx'
import {
  FishLogo,
  IconCloseFill14, IconNewChatOutline16, IconPanelLeftOutline16, IconPersonalizationOutline16,
  IconProjectAddOutline16, IconSearchOutline16, IconSettingsOutline14,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import { ProjectRowItem, SessionRowItem } from './Rows.tsx'
import css from './SidebarRoot.module.css'

const GROUP_BY_ITEMS = [
  { id: 'workspace', label: 'WorkSpace' },
  // Update/Status grouping has no design yet (figma §3) — visible, disabled.
  { id: 'update', label: 'Update', disabled: true },
  { id: 'status', label: 'Status', disabled: true },
]

/**
 * Render the sidebar column.
 * @param props - composed slot props (owner share + injected surface, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({ useTree, useCurrent, actions, tree }: SidebarRootComponentProps) {
  const rows = useTree((s) => s.rows)
  const query = useTree((s) => s.query)
  const groupBy = useTree((s) => s.groupBy)
  const current = useCurrent()
  const [menuOpen, setMenuOpen] = useState(false)
  const now = Date.now()

  // Presentational lookup (not tree derivation): the group holding the
  // selected session gets the active folder; only expanded groups can show it.
  let activeGroup: string | undefined
  if (current !== undefined) {
    for (const row of rows) {
      if (row.type === 'session' && row.id === current) { activeGroup = row.groupKey; break }
    }
  }

  return (
    <div className={css.root}>
      <div className={css.headerBlock}>
        <div className={css.logoRow}>
          <span className={css.brand}>
            {/* Wordmark svg not extracted yet (figma 88:8932) — text stands in at the same ink. */}
            <FishLogo size={23} />
            <span className={css.wordmark}>deepseek</span>
            <span className={css.badge}>HARNESS</span>
          </span>
          <button
            type="button"
            className={css.iconButton}
            aria-label="Collapse sidebar"
            onClick={() => { actions.toggleSidebar() }}
          >
            <IconPanelLeftOutline16 />
          </button>
        </div>

        <button type="button" className={css.newSession} onClick={() => { actions.create() }}>
          <IconNewChatOutline16 size={14} />
          New Session
        </button>
      </div>

      <div className={css.listArea}>
      <div className={css.sectionHeader}>
        <span className={css.sectionLabel}>WorkSpace</span>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={GROUP_BY_ITEMS}
          selectedId={groupBy}
          onSelect={() => { setMenuOpen(false) }}
          align="end"
          anchor={(
            <button
              type="button"
              className={css.iconButton}
              aria-label="Group by"
              onClick={() => { setMenuOpen((v) => !v) }}
            >
              <IconPersonalizationOutline16 />
            </button>
          )}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label="New workspace"
          onClick={() => { actions.create() }}
        >
          <IconProjectAddOutline16 />
        </button>
      </div>

      <label className={css.search}>
        <IconSearchOutline16 size={14} />
        <input
          className={css.searchInput}
          type="text"
          placeholder="Search name, keywords..."
          value={query}
          onChange={(e) => { tree.setQuery(e.target.value) }}
        />
        {query !== '' && (
          <button
            type="button"
            className={css.clearButton}
            aria-label="Clear search"
            onClick={() => { tree.setQuery('') }}
          >
            <IconCloseFill14 />
          </button>
        )}
      </label>

      <div className={css.list} role="tree" aria-label="Sessions">
        {rows.length === 0 && (
          <div className={css.empty}>{query === '' ? 'No sessions yet' : 'No matches'}</div>
        )}
        {rows.map((row, i) => row.type === 'project'
          ? (
              <Fragment key={`p:${row.key}`}>
                {/* Batch separator: a project row closing an expanded session run (figma 133:7661). */}
                {i > 0 && rows[i - 1]!.type === 'session' && <span className={css.batchGap} />}
                <ProjectRowItem
                  row={row}
                  active={row.key === activeGroup}
                  onToggle={() => { tree.toggleProject(row.key) }}
                  onCreate={() => { actions.create(row.cwd) }}
                />
              </Fragment>
            )
          : (
              <SessionRowItem
                key={row.id}
                row={row}
                selected={row.id === current}
                now={now}
                onOpen={() => { actions.open(row.id) }}
                onToggle={() => { tree.toggleSession(row.id) }}
              />
            ))}
      </div>
      <span className={css.fade} />
      </div>

      <div className={clsx(css.foot)} role="button" tabIndex={0} aria-label="Settings">
        <IconSettingsOutline14 />
        Settings
      </div>
    </div>
  )
}
