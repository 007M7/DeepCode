/**
 * The in-app workspace-directory browser (figma Harness 813-23126 family): a
 * 600×420 dialog (clamped to short/narrow viewports — the Miller row scrolls
 * sideways, the columns scroll down) whose header carries the title, the selection-path
 * breadcrumb, and a click-to-edit path zone; below it a Miller view — one
 * full-width level until a row is selected, then two 256px columns (level |
 * selected folder's children) around a hairline divider. Selecting in the
 * right column shifts the view one level deeper. "New folder" opens a nested
 * create dialog targeting the selected folder (or the level itself) and
 * selects the created folder. Open adopts the selected folder, falling back
 * to the listed level. Pure consumer of the injected browse calls — the
 * owning flow decides what "Open" means and owns the workspace-creation
 * error surface. Hidden entries are host-flagged and filtered here (a
 * show-hidden toggle is deferred work, client-side only).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16, IconPlusOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import css from './DirectoryBrowser.module.css'

/** Owner-supplied browser props: browse calls, pick semantics, and copy. */
export interface DirectoryBrowserProps {
  /** Dialog visibility (owner-local; closed unmounts nothing but resets on reopen). */
  open: boolean
  /** List one directory level (absent path = the Host home directory); the signal aborts a superseded scan on the wire. */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Create one child directory under an existing parent. */
  createDirectory: (path: string, name: string) => Promise<string>
  /** The operator confirmed a directory (the selection, else the listed level). */
  onOpen: (path: string) => void
  /** Close without picking (mask, Escape, Cancel). */
  onClose: () => void
  /** The owner's confirm is in flight: Open disables, the view freezes. */
  busy: boolean
  /** Localized copy. */
  t: Translate
}

/** Failure text: the Host business message when typed, else the throw's text. */
function failureText(error: unknown): string {
  if (error instanceof DirectoryBrowseError) return error.rpcError.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * Breadcrumb rows for display: inside the home subtree the chain starts at a
 * localized Home crumb; outside it the full ancestry shows, the root labeled
 * by its own path.
 */
function displayCrumbs(listing: DirectoryListing, homeLabel: string): DirectoryEntry[] {
  const homeIndex = listing.crumbs.findIndex(crumb => crumb.path === listing.home)
  if (homeIndex === -1) return listing.crumbs
  const tail = listing.crumbs.slice(homeIndex + 1)
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]
}

/** One column of folder rows (the Miller view renders one or two of these). */
function LevelColumn({ entries, selectedPath, busy, onPick, wide }: {
  entries: readonly DirectoryEntry[]
  selectedPath: string | null
  busy: boolean
  onPick: (entry: DirectoryEntry) => void
  wide: boolean
}) {
  return (
    <div className={clsx(css.column, wide && css.columnWide)} role="list">
      {entries.filter(entry => !entry.hidden).map((entry) => {
        const selected = entry.path === selectedPath
        return (
          // The wrapper carries the list semantics; the row keeps its NATIVE
          // button role so assistive technology exposes an actionable control.
          <span key={entry.path} role="listitem" className={css.rowSeat}>
            <button
              type="button"
              aria-current={selected || undefined}
              className={clsx(css.row, selected && css.rowSelected)}
              disabled={busy}
              onClick={() => { onPick(entry) }}
            >
              {selected
                ? <IconFolderOpen16 size={16} className={css.rowIconSelected} />
                : <IconFolderClose16 size={16} className={css.rowIcon} />}
              <span className={css.rowName}>{entry.name}</span>
              <IconChevronRightOutline14 size={12} className={css.rowChevron} />
            </button>
          </span>
        )
      })}
    </div>
  )
}

/**
 * Render the directory-browser dialog.
 * @param props - owner-controlled browser props.
 * @returns the dialog element (null while closed, via Modal).
 */
export function DirectoryBrowser({ open, listDirectory, createDirectory, onOpen, onClose, busy, t }: DirectoryBrowserProps) {
  // Miller state: the listed level, the selected row in it, and the selected
  // folder's own listing (the right column; null while nothing is selected).
  const [parent, setParent] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState<DirectoryEntry | null>(null)
  const [child, setChild] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Path-edit state: null = breadcrumb mode; a string = the draft being typed.
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  // Create-folder state: null = closed; a string = the nested dialog's draft.
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  // The in-flight listing's controller: superseding intent aborts the wire
  // request too — the Host stops scanning — instead of only discarding the
  // eventual result while the scan keeps consuming host resources.
  const scanController = useRef<AbortController | null>(null)
  // Bumped on every open/close edge: settlements from a previous open (a
  // pending creation included) must never mutate a reopened dialog.
  const openGeneration = useRef(0)
  // Deep ancestry overflows the trail; keep its tail (the current directory
  // and the edit zone beside it) in view whenever the chain changes.
  const crumbTrailRef = useRef<HTMLSpanElement | null>(null)
  // IME confirmation (Enter selecting a candidate) must not submit either
  // text input; the same guard the workspace-name inputs carry, shared by
  // the path editor and the folder-name input.
  const composingRef = useRef(false)
  // HMR/unmount invalidation: a completion from a disposed flow must not
  // update state or issue follow-up requests from a dead component.
  useEffect(() => () => {
    requestSeq.current += 1
    openGeneration.current += 1
    scanController.current?.abort()
  }, [])
  const compositionGuard = {
    onCompositionStart: () => { composingRef.current = true },
    onCompositionEnd: () => { composingRef.current = false },
  }

  /** Newer intent wins: invalidate the pending listing's settlement AND abort its wire request. */
  const supersede = useCallback((): number => {
    scanController.current?.abort()
    scanController.current = null
    return ++requestSeq.current
  }, [])

  /** Launch one listing under a fresh controller so a later supersession can abort it. */
  const launchListing = useCallback((path: string | undefined): { seq: number; scan: Promise<DirectoryListing> } => {
    const seq = supersede()
    const controller = new AbortController()
    scanController.current = controller
    return { seq, scan: listDirectory(path, controller.signal) }
  }, [supersede, listDirectory])

  /** Replace the whole view with one freshly listed level (no selection). */
  const navigate = useCallback((path?: string) => {
    const { seq, scan } = launchListing(path)
    setLoading(true)
    setError(null)
    scan.then((next) => {
      if (seq !== requestSeq.current) return
      setParent(next)
      setSelected(null)
      setChild(null)
      setLoading(false)
      setPathDraft(null)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
    })
  }, [launchListing])

  /** Select a row of the listed level and preview its children on the right. */
  const select = useCallback((entry: DirectoryEntry) => {
    const { seq, scan } = launchListing(entry.path)
    setSelected(entry)
    setChild(null)
    setLoading(true)
    setError(null)
    scan.then((next) => {
      if (seq !== requestSeq.current) return
      setChild(next)
      setLoading(false)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
      // An unreadable selection cannot be the committing target while the
      // breadcrumb still names the level: fall back to the single pane.
      setSelected(null)
    })
  }, [launchListing])

  /** A right-column pick advances the view one level: child becomes the level. */
  const advance = useCallback((entry: DirectoryEntry) => {
    /* v8 ignore next -- narrowing guard: the right column only renders with a child listing. */
    if (child === null) return
    setParent(child)
    select(entry)
  }, [child, select])

  // Every open starts fresh at the Host home directory; closing invalidates
  // any in-flight response so a late arrival cannot repopulate a closed dialog.
  useEffect(() => {
    openGeneration.current += 1
    if (open) {
      setParent(null)
      setSelected(null)
      setChild(null)
      setCreatingFolder(false)
      navigate()
      return
    }
    supersede()
    setError(null)
    setPathDraft(null)
    setFolderDraft(null)
    setCreateError(null)
  }, [open, navigate, supersede])

  /** The folder a create or Open acts on: the selection, else the listed level. */
  const targetPath = selected?.path ?? parent?.path ?? null
  const targetName = selected?.name
    ?? (parent === null ? '' : (displayCrumbs(parent, t('browser.home')).at(-1)?.name ?? parent.path))

  const confirmCreate = (): void => {
    /* v8 ignore next -- reentry fence: the nested dialog only renders with a target and disables while creating. */
    if (targetPath === null || folderDraft === null || creatingFolder) return
    // Trim only rejects an all-whitespace draft; the Host gets the original
    // spelling — the backend accepts any non-blank single segment verbatim,
    // and trimming here would create (and select) a different sibling.
    const name = folderDraft
    if (name.trim() === '') return
    setCreatingFolder(true)
    setCreateError(null)
    const generation = openGeneration.current
    createDirectory(targetPath, name).then((createdPath) => {
      // A settlement from a closed (possibly reopened) flow must not touch
      // the fresh dialog or issue a relist against the stale target.
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setFolderDraft(null)
      // Land like a right-column pick (figma 802:57446 → 813:23278 flow): the
      // create target becomes the listed level and the new folder its selection.
      const { seq, scan } = launchListing(targetPath)
      setLoading(true)
      scan.then((level) => {
        /* v8 ignore next -- same fence as navigate/select; the modal blocks superseding input */
        if (seq !== requestSeq.current) return
        setParent(level)
        setLoading(false)
        select({ name, path: createdPath, hidden: false })
      }, (reason: unknown) => {
        /* v8 ignore next -- same fence as navigate/select; the modal blocks superseding input */
        if (seq !== requestSeq.current) return
        setLoading(false)
        setError(failureText(reason))
      })
    }, (reason: unknown) => {
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setCreateError(failureText(reason))
    })
  }

  // After the hooks: a closed dialog renders nothing and evaluates no copy.
  const crumbSource = child ?? parent
  const crumbs = crumbSource === null ? [] : displayCrumbs(crumbSource, t('browser.home'))
  const crumbTail = crumbs.at(-1)?.path
  useEffect(() => {
    const trail = crumbTrailRef.current
    if (trail !== null) trail.scrollLeft = trail.scrollWidth
  }, [crumbTail])
  // On viewports too narrow for both fixed panes the Miller row scrolls;
  // whenever a child preview lands, pin it into view the way the crumb tail
  // pins — otherwise descent is unreachable on a phone-width window.
  const millerRowRef = useRef<HTMLDivElement | null>(null)
  const childPath = child?.path
  useEffect(() => {
    const row = millerRowRef.current
    if (row !== null && childPath !== undefined) row.scrollLeft = row.scrollWidth
  }, [childPath])

  if (!open) return null
  const twoPane = selected !== null
  // The nested create dialog owns the interaction while open: Modal has no
  // focus trap, so every parent control goes inert (Shift-Tab or AT must not
  // close, adopt, or retarget underneath the child).
  const parentInert = busy || folderDraft !== null
  // An uncommitted path draft makes targetPath stale relative to the header:
  // committing actions must not act on the previous selection/listing while
  // a different path is displayed.
  const draftPending = pathDraft !== null

  return (
    <Modal
      open={open}
      // Escape and mask reach every mounted Modal's document listener; while
      // the nested create dialog is up only that topmost dialog may close
      // (its own guard keeps an in-flight creation open), and an in-flight
      // adoption pins the flow — dismissing it would leave the owner's
      // createWorkspace to land after an apparent cancel.
      onClose={() => { if (folderDraft === null && !busy) onClose() }}
      title={t('browser.title')}
      className={clsx(css.dialog)}
      headless
    >
      <div className={css.header}>
        <h2 className={css.title}>{t('browser.title')}</h2>
        <div className={css.crumbBar}>
          {pathDraft === null
            ? (
              <>
                <span className={css.crumbTrail} role="navigation" ref={crumbTrailRef}>
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.path} className={css.crumbSeat}>
                      {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                      <button
                        type="button"
                        className={css.crumb}
                        disabled={parentInert}
                        onClick={() => { navigate(crumb.path) }}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </span>
                {/* The empty zone right of the crumbs is the path-edit affordance. */}
                <button
                  type="button"
                  className={css.crumbEditZone}
                  aria-label={t('browser.editPath')}
                  // Stays available with no listed level: when the home
                  // listing itself fails, typing an absolute path is the one
                  // remaining way forward.
                  disabled={parentInert}
                  onClick={() => {
                    // Opening the editor supersedes any pending listing: a
                    // settlement landing before the first keystroke would
                    // otherwise close the editor via navigate's draft reset.
                    supersede()
                    setLoading(false)
                    setPathDraft(selected?.path ?? parent?.path ?? '')
                  }}
                />
              </>
            )
            : (
              <input
                className={css.pathInput}
                value={pathDraft}
                aria-label={t('browser.editPath')}
                autoFocus
                disabled={parentInert}
                onChange={(event) => {
                  // Editing the draft supersedes any in-flight navigation:
                  // its completion must neither clear the newer text nor
                  // repopulate the view with the older path.
                  supersede()
                  setLoading(false)
                  setPathDraft(event.target.value)
                }}
                {...compositionGuard}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !composingRef.current) {
                    event.preventDefault()
                    // Trim only detects a blank draft; the Host gets the
                    // original text — a real directory name may end in
                    // whitespace, and trimming would list its sibling.
                    if (pathDraft.trim() !== '') navigate(pathDraft)
                  }
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    // Cancel also withdraws a navigation the editor already
                    // launched: its late success must not jump to the
                    // cancelled path, so the pending request is superseded
                    // and the view leaves the loading state.
                    supersede()
                    setLoading(false)
                    setPathDraft(null)
                    setError(null)
                    // Editing may have superseded the selection's preview
                    // request; a selection with no preview would render a
                    // half-empty two-pane view, so cancel falls back to the
                    // single-pane level.
                    if (child === null) setSelected(null)
                    // With no level listed yet (the editor superseded the
                    // initial home listing), plain cancellation would leave a
                    // permanently blank picker: restart the home listing.
                    if (parent === null) navigate()
                  }
                }}
              />
            )}
        </div>
      </div>
      <div className={css.content}>
        <div className={css.millerRow} ref={millerRowRef}>
          {parent !== null && (
            <LevelColumn
              entries={parent.entries}
              selectedPath={selected?.path ?? null}
              busy={parentInert}
              onPick={select}
              wide={!twoPane}
            />
          )}
          {twoPane && <span className={css.divider} />}
          {twoPane && child !== null && (
            <LevelColumn
              entries={child.entries}
              selectedPath={null}
              busy={parentInert}
              onPick={advance}
              wide={false}
            />
          )}
        </div>
        {loading && <div className={css.status} role="status">{t('browser.loading')}</div>}
        {/* The backend bounds a level at its complete-result limit; say so
          * whenever a visible pane was cut instead of letting the tail of a
          * huge directory go silently missing. */}
        {(parent?.truncated === true || child?.truncated === true) && !loading
          && <div className={css.status} role="status">{t('browser.truncated')}</div>}
        {error !== null && <div className={css.error} role="alert">{error}</div>}
      </div>
      <div className={css.footerBar}>
        <Button
          variant="outline"
          icon={<IconPlusOutline16 size={14} />}
          disabled={parent === null || loading || parentInert || draftPending}
          onClick={() => {
            setFolderDraft('')
            setCreateError(null)
          }}
        >
          {t('browser.newFolder')}
        </Button>
        <span className={css.footerGap} />
        <Button variant="outline" className={clsx(css.footerAction)} disabled={parentInert} onClick={onClose}>{t('browser.cancel')}</Button>
        <Button
          variant="primary"
          className={clsx(css.footerAction)}
          disabled={targetPath === null || loading || parentInert || draftPending}
          /* v8 ignore next -- narrowing guard: Open disables while no target exists. */
          onClick={() => { if (targetPath !== null) onOpen(targetPath) }}
        >
          {t('browser.open')}
        </Button>
      </div>
      {/* Nested create dialog (figma 813:23278): names one folder inside the target. */}
      <Modal
        open={folderDraft !== null}
        onClose={() => { if (!creatingFolder) setFolderDraft(null) }}
        title={t('browser.newFolder')}
        className={clsx(css.createDialog)}
        headless
      >
        <div className={css.createBody}>
          <h3 className={css.createTitle}>{t('browser.newFolder')}</h3>
          <p className={css.createIn}>{t('browser.createIn', { name: targetName })}</p>
          <input
            className={css.createInput}
            value={folderDraft ?? ''}
            aria-label={t('browser.folderName')}
            placeholder={t('browser.untitledFolder')}
            autoFocus
            disabled={creatingFolder}
            onChange={(event) => { setFolderDraft(event.target.value) }}
            {...compositionGuard}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !composingRef.current) {
                event.preventDefault()
                confirmCreate()
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (!creatingFolder) setFolderDraft(null)
              }
            }}
          />
          {createError !== null && <div className={css.error} role="alert">{createError}</div>}
          <div className={css.createActions}>
            <Button variant="outline" disabled={creatingFolder} onClick={() => { setFolderDraft(null) }}>{t('browser.cancel')}</Button>
            <Button
              variant="primary"
              disabled={creatingFolder || folderDraft === null || folderDraft.trim() === ''}
              onClick={confirmCreate}
            >
              {t('browser.create')}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}
