/**
 * Collapse is a slide plus crossfade: content freezes at its expanded
 * width (inline style) and fades out in place while the sliding column
 * (AppFrame grid tracks) clips it — nothing reflows mid-slide. At settle
 * the wide-only content (brand, labels, input, tree) unmounts, dropping
 * the sessions subscription, and the control rows snap to the 56px rail
 * (one icon each, same top-down order) fading in as the slide ends. Rail
 * search expands and focuses the search box.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  BrandWordmark, FishLogo,
  IconCloseFill14, IconNewChatOutline16, IconPanelLeftOutline16, IconPersonalizationOutline16,
  IconProjectAddOutline16, IconSearchOutline16, IconSettingsOutline14,
  Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import { deriveGroups, UNGROUPED_KEY } from './tree.ts'
import { IntentRowItem, ProjectRowItem, SessionNodeItem } from './Rows.tsx'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/** Column slide length (--ds-transition-duration-slow): rail-search focus waits it out — focus() forces a synchronous layout and would jank the slide. */
const EXPAND_SLIDE_MS = 300

const GROUP_BY_ITEMS = [
  { id: 'workspace', label: 'Workspace' },
  // Only workspace grouping is implemented.
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

type SessionTreeProps = Pick<
  SidebarRootComponentProps,
  'useSessions' | 'startSession' | 'open'
> & {
  workspaces: readonly WorkspaceView[]
  /** Live search filter owned by the root (the query outlives the tree). */
  query: string
}

/** The scrolling session tree; unmounting at collapse settle drops the sessions subscription and expansion state. */
function SessionTree({ useSessions, startSession, open, workspaces, query }: SessionTreeProps) {
  const list = useSessions((s) => s)
  const current = list.current
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])
  const [expandedSessions, setExpandedSessions] = useState<string[]>([])
  // Re-expand when publication moves the selected intent into a real Workspace.
  const intent = list.intent
  const intentWorkspaceId = intent?.target.kind === 'workspace'
    ? intent.target.workspaceId
    : undefined
  const currentGroup = current === undefined
    ? undefined
    : intent?.sessionId === current
      ? intentWorkspaceId
      : (workspaces.find(w => w.sessionIds.includes(current))?.workspaceId as string | undefined)
        ?? UNGROUPED_KEY
  useEffect(() => {
    if (current === undefined || currentGroup === undefined) return
    setExpandedProjects((l) => (l.includes(currentGroup) ? l : [...l, currentGroup]))
  }, [current, currentGroup])
  const groups = useMemo(
    () => deriveGroups(list, workspaces, { expandedProjects, expandedSessions, query }),
    [list, workspaces, expandedProjects, expandedSessions, query],
  )
  const now = Date.now()

  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={css.list} role="tree" aria-label="Sessions">
        {groups.length === 0 && (
          <div className={css.empty}>{query === '' ? 'No sessions yet' : 'No matches'}</div>
        )}
        {groups.map(group => (
          // Group section: header row + expanded session subtree. The
          // inter-group breathing room (former flat-list batch separator)
          // is the section's own margin (SidebarRoot.module.css).
          <div key={group.key} className={css.groupSection}>
            <ProjectRowItem
              group={group}
              onToggle={() => { setExpandedProjects((l) => toggled(l, group.key)) }}
              onCreate={() => {
                if (group.workspaceId !== undefined) startSession(group.workspaceId)
              }}
            />
            {group.intentHere && <IntentRowItem />}
            {group.sessions.map(node => (
              <SessionNodeItem
                key={node.id}
                node={node}
                depth={0}
                currentId={current}
                now={now}
                onOpen={open}
                onToggle={(id) => { setExpandedSessions((l) => toggled(l, id)) }}
              />
            ))}
          </div>
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
export function SidebarRoot({
  collapsed,
  width,
  useSessions,
  useWorkspaces,
  startSession,
  open,
  toggleSidebar,
  renderSlot,
}: SidebarRootComponentProps) {
  const workspaces = useWorkspaces(state => state.items)
  // The query outlives the tree and the input (both wide-only) so collapsing
  // does not silently drop an in-progress filter.
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement | null>(null)
  // Section-header ＋ opens the workspace picker (same popover in wide and
  // rail states; the hole sits beside the button and opens rightward).
  const [wsPickerOpen, setWsPickerOpen] = useState(false)
  // Placement anchor for the picker popover: the slot span renders elsewhere
  // in the DOM, so the picker positions off this button's rect.
  const wsPlusRef = useRef<HTMLButtonElement>(null)

  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Rail search = expand + land in the search box: the flag arms before the
  // expand toggle; once expanded the input is mounted and takes focus.
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (!collapsed && searchOnExpand) {
      const timer = window.setTimeout(() => {
        searchInput.current?.focus({ preventScroll: true })
        setSearchOnExpand(false)
      }, EXPAND_SLIDE_MS)
      return () => { window.clearTimeout(timer) }
    }
  }, [collapsed, searchOnExpand])

  return (
    <div
      className={clsx(css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn, collapsed && wide && css.fading)}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
    >
      <div className={css.logoRow}>
        {wide && (
          <span className={clsx(css.brand, css.wide)}>
            <BrandWordmark />
          </span>
        )}
        {/* Rail resting state is the whale mark; hovering swaps in the panel
            icon (the expand affordance, figma sidebar-hover flow). */}
        <Tooltip label="Open sidebar" disabled={wide}>
          <button
            type="button"
            className={clsx(css.iconButton, css.toggle)}
            aria-label={collapsed ? 'Open sidebar' : 'Collapse sidebar'}
            onClick={() => { toggleSidebar() }}
          >
            {!wide && <FishLogo className={css.railFish} size={24} />}
            {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
            <IconPanelLeftOutline16 className={css.panelIcon} size={wide ? 16 : 18} />
          </button>
        </Tooltip>
      </div>

      <Tooltip label="New session" disabled={wide}>
        <button
          type="button"
          className={css.newSession}
          aria-label="New session"
          onClick={() => { startSession() }}
        >
          <IconNewChatOutline16 size={wide ? 14 : 18} />
          {wide && <span className={clsx(css.newSessionLabel, css.wide)}>New Session</span>}
        </button>
      </Tooltip>

      <div className={css.sectionHeader}>
        {wide && <span className={clsx(css.sectionLabel, css.wide)}>Workspaces</span>}
        {wide && <GroupByMenu />}
        <Tooltip label="New Workspace" disabled={wide}>
          <button
            ref={wsPlusRef}
            type="button"
            className={css.iconButton}
            aria-label="Create workspace"
            onClick={() => { setWsPickerOpen(v => !v) }}
          >
            <IconProjectAddOutline16 size={wide ? 16 : 18} />
          </button>
        </Tooltip>
        {/* Picker hole beside the ＋ (same site in wide and rail states). */}
        {renderSlot('sidebar.workspace', {
          open: wsPickerOpen,
          anchorRef: wsPlusRef,
          onPick: (workspaceId) => {
            setWsPickerOpen(false)
            startSession(workspaceId)
          },
          onClose: () => { setWsPickerOpen(false) },
        })}
      </div>

      {/* Expanded: the row is a click-to-focus field (the leading icon is
          decorative). Collapsed: the icon is the rail's search control. */}
      <div className={css.search} onClick={() => { if (!collapsed) searchInput.current?.focus() }}>
        <Tooltip label="Search" disabled={wide}>
          <button
            type="button"
            className={css.searchButton}
            aria-label="Search sessions"
            tabIndex={collapsed ? 0 : -1}
            onClick={() => { if (collapsed) { setSearchOnExpand(true); toggleSidebar() } }}
          >
            <IconSearchOutline16 size={wide ? 14 : 18} />
          </button>
        </Tooltip>
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
        {wide && (
          <SessionTree
            useSessions={useSessions}
            workspaces={workspaces}
            startSession={startSession}
            open={open}
            query={query}
          />
        )}
      </div>

      <div className={css.foot} role="button" tabIndex={0} aria-label="Settings">
        <IconSettingsOutline14 size={wide ? 14 : 18} />
        {wide && <span className={clsx(css.footLabel, css.wide)}>Settings</span>}
      </div>
    </div>
  )
}
