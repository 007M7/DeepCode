/**
 * The workspace/session browsing region filling the sidebar shell's
 * `sidebar.workspaces` hole: section header (title + group-by + new
 * workspace), search, the grouped tree or flat list, and the workspace
 * dialogs. Wide state renders the full browser; rail state renders the two
 * region icons (search / new workspace), each requesting shell expansion
 * through the owner share. The picker menu and create dialogs live in
 * WorkspacePicker (same package — direct composition, no slot between them).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCloseFill14, IconPersonalizationOutline16,
  IconProjectAddOutline16, IconSearchOutline16, Menu, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type { SessionNode } from './tree.ts'
import { deriveFlat, deriveGroups, UNGROUPED_KEY } from './tree.ts'
import { ProjectRowItem, SessionNodeItem } from './rows/Rows.tsx'
import { WorkspaceCreateFlow } from './WorkspacePicker.tsx'
import css from './WorkspaceBrowser.module.css'

/**
 * Column slide length (--ds-transition-duration-slow): rail-search focus waits it out —
 * focus() forces a synchronous layout and would jank the slide.
 */
const EXPAND_SLIDE_MS = 300

const GROUP_BY_ITEMS = [
  { type: 'label' as const, id: 'group-by', text: 'Group by' },
  { id: 'workspace', label: 'WorkSpace' },
  { id: 'flat', label: 'In one list' },
]

/** Immutable membership toggle for the local expansion arrays. */
function toggled(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(k => k !== key) : [...list, key]
}

/** Group-by strategy menu; own open state so it resets with the wide chrome. */
function GroupByMenu({ groupBy, onPick }: {
  groupBy: 'workspace' | 'flat'
  onPick: (mode: 'workspace' | 'flat') => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={GROUP_BY_ITEMS}
      selectedId={groupBy}
      onSelect={(id) => {
        /* v8 ignore next -- narrowing guard: the heading label is not selectable, so the only arriving ids are the two modes. */
        if (id === 'workspace' || id === 'flat') onPick(id)
        setOpen(false)
      }}
      align="end"
      // Portal: the section header clips overflow, so an in-place list would
      // be cut off at the header's bounds.
      portal
      anchor={(
        <button
          type="button"
          className={clsx(css.iconButton, css.wide)}
          aria-label="Group by"
          onClick={() => { setOpen(v => !v) }}
        >
          <IconPersonalizationOutline16 />
        </button>
      )}
    />
  )
}

/** In-flight root-row drag: source identity plus the current insert marker. */
interface DragState {
  workspaceId: WorkspaceId
  sessionId: SessionNode['id']
  /** Row the marker sits on and which half (insert above/below it). */
  over: { id: SessionNode['id']; half: 'before' | 'after' } | null
}

type SessionTreeProps = Pick<
  WorkspaceBrowserProps,
  'useSessions' | 'startSession' | 'open' | 'insertSessionBefore'
> & {
  workspaces: readonly WorkspaceView[]
  /** Live search filter owned by the browser root (the query outlives the tree). */
  query: string
  /** Open the browser-owned rename dialog for a real Workspace group. */
  onRenameRequest: (workspaceId: WorkspaceId, currentTitle: string) => void
  /** Open the browser-owned delete-confirmation dialog for a real Workspace group. */
  onDeleteRequest: (workspaceId: WorkspaceId, currentTitle: string) => void
}

/** The scrolling session tree; unmounting at collapse settle drops the sessions subscription and expansion state. */
function SessionTree({
  useSessions, startSession, open, workspaces, query,
  onRenameRequest, onDeleteRequest, insertSessionBefore,
}: SessionTreeProps) {
  const list = useSessions(s => s)
  const current = list.current
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])
  const [expandedSessions, setExpandedSessions] = useState<string[]>([])
  // Transient drag viewing state (never store-bound; order truth stays Host-side).
  const [drag, setDrag] = useState<DragState | null>(null)
  const currentGroup = current === undefined
    ? undefined
    : (workspaces.find(w => w.sessionIds.includes(current))?.workspaceId as string | undefined)
      ?? UNGROUPED_KEY
  useEffect(() => {
    if (current === undefined || currentGroup === undefined) return
    setExpandedProjects(l => (l.includes(currentGroup) ? l : [...l, currentGroup]))
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
          // is the section's own margin (WorkspaceBrowser.module.css).
          <div key={group.key} className={css.groupSection}>
            <ProjectRowItem
              group={group}
              onToggle={() => { setExpandedProjects(l => toggled(l, group.key)) }}
              onCreate={() => {
                if (group.workspaceId !== undefined) startSession(group.workspaceId)
              }}
              actions={group.workspaceId === undefined
                ? undefined
                : {
                  rename: () => {
                    /* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
                    if (group.workspaceId !== undefined) onRenameRequest(group.workspaceId, group.label)
                  },
                  delete: () => {
                    /* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
                    if (group.workspaceId !== undefined) onDeleteRequest(group.workspaceId, group.label)
                  },
                }}
            />
            {group.sessions.map((node, index) => {
              // Draggable: real-workspace group roots outside search. The drag
              // never leaves its group — rows of other groups show no markers
              // and reject drops (visual movement confined to this section).
              const draggable = group.workspaceId !== undefined && query === ''
              const sameGroupDrag = drag !== null && drag.workspaceId === group.workspaceId
              const dragProps = !draggable || group.workspaceId === undefined ? undefined : {
                start: () => {
                  setDrag({ workspaceId: group.workspaceId as WorkspaceId, sessionId: node.id, over: null })
                },
                active: sameGroupDrag,
                marker: sameGroupDrag && drag.over?.id === node.id ? drag.over.half : null,
                hover: (half: 'before' | 'after') => {
                  /* v8 ignore next -- narrowing guard: Rows gates hover on `active`, which is false while the drag state is null. */
                  setDrag(d => (d === null ? d : { ...d, over: { id: node.id, half } }))
                },
                drop: (half: 'before' | 'after') => {
                  /* v8 ignore next -- narrowing guard: Rows gates drop on `active`, which is false while the drag state is null. */
                  if (drag === null) return
                  const roots = group.sessions
                  // Anchor = the row the insert line points at ('after' means
                  // the next root; end-of-list omits the anchor → append).
                  const anchor = half === 'before' ? node.id : roots[index + 1]?.id
                  setDrag(null)
                  if (anchor === drag.sessionId) return
                  // No-op when the drop lands back on the source position.
                  const sourceIndex = roots.findIndex(r => r.id === drag.sessionId)
                  const anchorIndex = anchor === undefined ? roots.length : roots.findIndex(r => r.id === anchor)
                  if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
                  insertSessionBefore(drag.workspaceId, drag.sessionId, anchor).catch((reason: unknown) => {
                    console.warn('session reorder rejected:', reason)
                  })
                },
                end: () => { setDrag(null) },
              }
              return (
                <SessionNodeItem
                  key={node.id}
                  node={node}
                  depth={0}
                  currentId={current}
                  now={now}
                  onOpen={open}
                  onToggle={(id) => { setExpandedSessions(l => toggled(l, id)) }}
                  drag={dragProps}
                />
              )
            })}
          </div>
        ))}
      </div>
      <span className={css.fade} />
    </div>
  )
}

/** The flat "In one list" body: every session a top-level row, newest-first. */
function FlatList({ useSessions, open, query }: Pick<SessionTreeProps, 'useSessions' | 'open' | 'query'>) {
  const list = useSessions(s => s)
  const rows = useMemo(() => deriveFlat(list, { query }), [list, query])
  const now = Date.now()
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={css.list} role="tree" aria-label="Sessions">
        {rows.length === 0 && (
          <div className={css.empty}>{query === '' ? 'No sessions yet' : 'No matches'}</div>
        )}
        {rows.map(node => (
          <SessionNodeItem
            key={node.id}
            node={node}
            depth={0}
            currentId={list.current}
            now={now}
            onOpen={open}
            /* v8 ignore next -- required-prop filler: flat rows render no twist, so it never fires. */
            onToggle={() => {}}
            flat
          />
        ))}
      </div>
      <span className={css.fade} />
    </div>
  )
}

/**
 * Render the browsing region.
 * @param props - composed slot props (shell owner share + store + injected actions).
 * @returns the region element tree.
 */
export function WorkspaceBrowser({
  wide,
  expandSidebar,
  useSessions,
  useWorkspaces,
  useStore,
  actions,
  startSession,
  open,
  renameWorkspace,
  deleteWorkspace,
  insertSessionBefore,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
}: WorkspaceBrowserProps) {
  const workspaces = useWorkspaces(state => state.items)
  const groupBy = useStore(s => s.groupBy)
  // The query outlives the tree and the input (both wide-only) so collapsing
  // does not silently drop an in-progress filter.
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement | null>(null)
  // Section-header ＋ opens the picker menu (same popover in wide and rail
  // states; the menu anchors on this button).
  const [wsPickerOpen, setWsPickerOpen] = useState(false)
  const wsPlusRef = useRef<HTMLButtonElement>(null)
  const composingRef = useRef(false)

  // Rail search = expand + land in the search box: the flag arms before the
  // expand request; once the shell flips wide the input mounts and takes focus.
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (wide && searchOnExpand) {
      const timer = window.setTimeout(() => {
        searchInput.current?.focus({ preventScroll: true })
        setSearchOnExpand(false)
      }, EXPAND_SLIDE_MS)
      return () => { window.clearTimeout(timer) }
    }
  }, [wide, searchOnExpand])

  // Rename dialog (browser-owned so it outlives row unmounts during collapse).
  const [renameTarget, setRenameTarget] = useState<{ workspaceId: WorkspaceId; currentTitle: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameTrimmed = renameDraft.trim()
  const renameDuplicate = renameTarget !== null && renameTrimmed !== '' && renameTrimmed !== renameTarget.currentTitle
    && workspaces.some(w => w.title === renameTrimmed)
  const renameBlocked = renaming || renameTrimmed === ''
    || renameTarget === null || renameTrimmed === renameTarget.currentTitle || renameDuplicate
  const closeRename = () => {
    if (renaming) return
    setRenameTarget(null)
    setRenameError(null)
  }
  const confirmRename = () => {
    if (renameBlocked) return
    setRenaming(true)
    setRenameError(null)
    renameWorkspace(renameTarget.workspaceId, renameTrimmed).then(() => {
      setRenaming(false)
      setRenameTarget(null)
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  // Delete dialog is separate from the row so a successful removal can
  // unmount that row without tearing down the in-flight confirmation state.
  const [deleteTarget, setDeleteTarget] = useState<{ workspaceId: WorkspaceId; title: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteCommittedId, setDeleteCommittedId] = useState<WorkspaceId | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    if (deleteCommittedId === null
      || workspaces.some(workspace => workspace.workspaceId === deleteCommittedId)) return
    setDeleting(false)
    setDeleteCommittedId(null)
    setDeleteTarget(null)
  }, [deleteCommittedId, workspaces])
  const closeDelete = () => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
  }
  const confirmDelete = () => {
    /* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
    if (deleting || deleteTarget === null) return
    setDeleting(true)
    setDeleteCommittedId(null)
    setDeleteError(null)
    deleteWorkspace(deleteTarget.workspaceId).then(() => {
      // Keep the confirmation pending until this component has rendered the
      // committed list projection without the deleted id. Closing earlier
      // exposes one stale React frame to the next Create Workspace gesture.
      setDeleteCommittedId(deleteTarget.workspaceId)
    }).catch((reason: unknown) => {
      setDeleting(false)
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <div className={clsx(css.root, !wide && css.rail)}>
      <div className={css.sectionHeader}>
        {wide && (
          <span className={clsx(css.sectionLabel, css.wide)}>
            {groupBy === 'flat' ? 'Sessions' : 'Workspaces'}
          </span>
        )}
        {wide && <GroupByMenu groupBy={groupBy} onPick={(mode) => { actions.setGroupBy(mode) }} />}
        <Tooltip label="New Workspace" disabled={wide}>
          <button
            ref={wsPlusRef}
            type="button"
            className={css.iconButton}
            aria-label="Create workspace"
            onClick={() => {
              setWsPickerOpen(v => !v)
            }}
          >
            <IconProjectAddOutline16 size={wide ? 16 : 18} />
          </button>
        </Tooltip>
        {/* Picker menu + create dialogs (same package — direct composition). */}
        <WorkspaceCreateFlow
          open={wsPickerOpen}
          anchorRef={wsPlusRef}
          useWorkspaces={useWorkspaces}
          createWorkspace={createWorkspace}
          useDirectoryFlow={useDirectoryFlow}
          renderDirectoryFlow={owner => renderSlot('sidebar.workspaces.directoryFlow', owner)}
          createOnly
          side="right"
          onPick={(workspaceId) => {
            setWsPickerOpen(false)
            startSession(workspaceId)
          }}
          onClose={() => { setWsPickerOpen(false) }}
        />
      </div>

      {/* Expanded: the row is a click-to-focus field (the leading icon is
          decorative). Rail: the icon is the region's search control. */}
      <div className={css.search} onClick={() => { if (wide) searchInput.current?.focus() }}>
        <Tooltip label="Search" disabled={wide}>
          <button
            type="button"
            className={css.searchButton}
            aria-label="Search sessions"
            tabIndex={wide ? -1 : 0}
            onClick={() => { if (!wide) { setSearchOnExpand(true); expandSidebar() } }}
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

      {/* Always-mounted seat keeps the region's flex slot while the list
          itself is wide-only. */}
      <div className={css.listArea}>
        {wide && (groupBy === 'flat'
          ? <FlatList useSessions={useSessions} open={open} query={query} />
          : (
            <SessionTree
              useSessions={useSessions}
              workspaces={workspaces}
              startSession={startSession}
              open={open}
              query={query}
              insertSessionBefore={insertSessionBefore}
              onRenameRequest={(workspaceId, currentTitle) => {
                setRenameTarget({ workspaceId, currentTitle })
                setRenameDraft(currentTitle)
                setRenameError(null)
              }}
              onDeleteRequest={(workspaceId, title) => {
                setDeleteTarget({ workspaceId, title })
                setDeleteError(null)
              }}
            />
          ))}
      </div>

      <Modal
        open={renameTarget !== null}
        onClose={closeRename}
        title="Rename workspace"
        footer={(
          <>
            <Button variant="outline" disabled={renaming} onClick={closeRename}>Cancel</Button>
            <Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>Rename</Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={renameDraft}
          aria-label="Workspace name"
          autoFocus
          disabled={renaming}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setRenameDraft(e.target.value); setRenameError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmRename()
            }
          }}
        />
        {renameDuplicate && (
          <div className={css.renameError} role="alert">A workspace named “{renameTrimmed}” already exists.</div>
        )}
        {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
      </Modal>
      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        title="Delete workspace"
        {...deleteTarget === null
          ? {}
          : { description: `This removes “${deleteTarget.title}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.` }}
        footer={(
          <>
            <Button variant="outline" disabled={deleting} onClick={closeDelete}>Cancel</Button>
            <Button
              variant="outline"
              className={css.deleteAction}
              disabled={deleting}
              onClick={confirmDelete}
            >
              Delete workspace
            </Button>
          </>
        )}
      >
        {deleting && <div className={css.deleteStatus} role="status">Deleting workspace…</div>}
        {deleteError !== null && <div className={css.renameError} role="alert">{deleteError}</div>}
      </Modal>
    </div>
  )
}
