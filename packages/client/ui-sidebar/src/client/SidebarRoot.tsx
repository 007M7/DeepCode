/**
 * SidebarRoot (figma 133:7629): logo row + collapse, New Session, WorkSpace
 * section header with the group-by menu, search, session tree list, Settings
 * foot. Pure presentational — the session list arrives through the standard
 * useSessions hook, viewing state (expansion, search) is local component
 * state, and rows are derived in render via useMemo (slot design section 6:
 * derived data is a pure function, no materializing store).
 *
 * Collapse is a morph, not a swap: the four control rows persist into the
 * 56px rail (collapse/new session/new workspace/search, one icon each, same
 * top-down order as their expanded rows) and animate their geometry on the
 * deepsuite curve, while wide-only content (brand, labels, input, tree)
 * cross-fades out and unmounts once the collapse settles — dropping the
 * sessions subscription. Rail search expands and focuses the search box.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  FishLogo,
  IconCloseFill14, IconNewChatOutline16, IconPanelLeftOutline16, IconPersonalizationOutline16,
  IconProjectAddOutline16, IconSearchOutline16, IconSettingsOutline14,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import { deriveRows } from './tree.ts'
import { ProjectRowItem, SessionRowItem } from './Rows.tsx'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches --ds-transition-duration-slow (0.3s). */
const COLLAPSE_SETTLE_MS = 300

const GROUP_BY_ITEMS = [
  { id: 'workspace', label: 'WorkSpace' },
  // Update/Status grouping has no design yet (figma §3) — visible, disabled.
  { id: 'update', label: 'Update', disabled: true },
  { id: 'status', label: 'Status', disabled: true },
]

/** Immutable membership toggle for the local expansion arrays. */
function toggled(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
}

/** Group-by strategy menu; own open state so it resets with the wide chrome. */
function GroupByMenu() {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={GROUP_BY_ITEMS}
      selectedId="workspace"
      onSelect={() => { setOpen(false) }}
      align="end"
      anchor={(
        <button
          type="button"
          className={clsx(css.iconButton, css.wide)}
          aria-label="Group by"
          onClick={() => { setOpen((v) => !v) }}
        >
          <IconPersonalizationOutline16 />
        </button>
      )}
    />
  )
}

type SessionTreeProps = Pick<SidebarRootComponentProps, 'useSessions' | 'onOpen' | 'onCreate'> & {
  /** Live search filter owned by the root (the query outlives the tree). */
  query: string
}

/** The scrolling session tree; unmounting at collapse settle drops the sessions subscription and expansion state. */
function SessionTree({ useSessions, onOpen, onCreate, query }: SessionTreeProps) {
  const list = useSessions((s) => s)
  // Wave-2 seam: row highlight expects `current` on the sessions list
  // snapshot (sessions.current lives with the runtime sessions service).
  const current = useSessions((s) => s.current)
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])
  const [expandedSessions, setExpandedSessions] = useState<string[]>([])
  const rows = useMemo(
    () => deriveRows(list, { expandedProjects, expandedSessions, query }),
    [list, expandedProjects, expandedSessions, query],
  )
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
    <div className={clsx(css.treeBody, css.wide)}>
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
                  onToggle={() => { setExpandedProjects((l) => toggled(l, row.key)) }}
                  onCreate={() => { onCreate(row.cwd) }}
                />
              </Fragment>
            )
          : (
              <SessionRowItem
                key={row.id}
                row={row}
                selected={row.id === current}
                now={now}
                onOpen={() => { onOpen(row.id) }}
                onToggle={() => { setExpandedSessions((l) => toggled(l, row.id)) }}
              />
            ))}
      </div>
      <span className={css.fade} />
    </div>
  )
}

/**
 * Render the sidebar column.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({ collapsed, useSessions, onOpen, onCreate, onToggleSidebar }: SidebarRootComponentProps) {
  // The query outlives the tree and the input (both wide-only) so collapsing
  // does not silently drop an in-progress filter.
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement | null>(null)

  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Rail search = expand + land in the search box: the flag arms before the
  // expand toggle; once expanded the input is mounted and takes focus.
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (!collapsed && searchOnExpand) {
      searchInput.current?.focus()
      setSearchOnExpand(false)
    }
  }, [collapsed, searchOnExpand])

  return (
    <div className={clsx(css.root, collapsed && css.collapsed)}>
      <div className={css.logoRow}>
        {wide && (
          <span className={clsx(css.brand, css.wide)}>
            {/* Wordmark svg not extracted yet (figma 88:8932) — text stands in at the same ink. */}
            <FishLogo size={23} />
            <span className={css.wordmark}>deepseek</span>
            <span className={css.badge}>HARNESS</span>
          </span>
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => { onToggleSidebar() }}
        >
          <IconPanelLeftOutline16 />
        </button>
      </div>

      <button
        type="button"
        className={css.newSession}
        aria-label="New session"
        onClick={() => { onCreate() }}
      >
        <IconNewChatOutline16 size={14} />
        {wide && <span className={clsx(css.newSessionLabel, css.wide)}>New Session</span>}
      </button>

      <div className={css.sectionHeader}>
        {wide && <span className={clsx(css.sectionLabel, css.wide)}>WorkSpace</span>}
        {wide && <GroupByMenu />}
        <button
          type="button"
          className={css.iconButton}
          aria-label="New workspace"
          onClick={() => { onCreate() }}
        >
          <IconProjectAddOutline16 />
        </button>
      </div>

      {/* Expanded: the row is a click-to-focus field (the leading icon is
          decorative). Collapsed: the icon is the rail's search control. */}
      <div className={css.search} onClick={() => { if (!collapsed) searchInput.current?.focus() }}>
        <button
          type="button"
          className={css.searchButton}
          aria-label="Search sessions"
          tabIndex={collapsed ? 0 : -1}
          onClick={() => { if (collapsed) { setSearchOnExpand(true); onToggleSidebar() } }}
        >
          <IconSearchOutline16 size={14} />
        </button>
        {wide && (
          <input
            ref={searchInput}
            className={clsx(css.searchInput, css.wide)}
            type="text"
            placeholder="Search name, keywords..."
            value={query}
            onChange={(e) => { setQuery(e.target.value) }}
          />
        )}
        {wide && query !== '' && (
          <button
            type="button"
            className={clsx(css.clearButton, css.wide)}
            aria-label="Clear search"
            onClick={() => { setQuery('') }}
          >
            <IconCloseFill14 />
          </button>
        )}
      </div>

      {/* Always-mounted seat: its flex slot pins the foot to the bottom in
          both states while the tree itself is wide-only. */}
      <div className={css.listArea}>
        {wide && <SessionTree useSessions={useSessions} onOpen={onOpen} onCreate={onCreate} query={query} />}
      </div>

      <div className={css.foot} role="button" tabIndex={0} aria-label="Settings">
        <IconSettingsOutline14 />
        {wide && <span className={clsx(css.footLabel, css.wide)}>Settings</span>}
      </div>
    </div>
  )
}
