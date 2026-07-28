/**
 * The in-app workspace-directory browser (figma Harness 813-23126 family): a
 * fixed 600×420 dialog whose header carries the title, the selection-path
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
  /** List one directory level (absent path = the Host home directory). */
  listDirectory: (path?: string) => Promise<DirectoryListing>
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
          <button
            key={entry.path}
            type="button"
            role="listitem"
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
  // Deep ancestry overflows the trail; keep its tail (the current directory
  // and the edit zone beside it) in view whenever the chain changes.
  const crumbTrailRef = useRef<HTMLSpanElement | null>(null)

  /** Replace the whole view with one freshly listed level (no selection). */
  const navigate = useCallback((path?: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    listDirectory(path).then((next) => {
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
  }, [listDirectory])

  /** Select a row of the listed level and preview its children on the right. */
  const select = useCallback((entry: DirectoryEntry) => {
    const seq = ++requestSeq.current
    setSelected(entry)
    setChild(null)
    setLoading(true)
    setError(null)
    listDirectory(entry.path).then((next) => {
      if (seq !== requestSeq.current) return
      setChild(next)
      setLoading(false)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
    })
  }, [listDirectory])

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
    if (open) {
      setParent(null)
      setSelected(null)
      setChild(null)
      navigate()
      return
    }
    requestSeq.current += 1
    setError(null)
    setPathDraft(null)
    setFolderDraft(null)
    setCreateError(null)
  }, [open, navigate])

  /** The folder a create or Open acts on: the selection, else the listed level. */
  const targetPath = selected?.path ?? parent?.path ?? null
  const targetName = selected?.name
    ?? (parent === null ? '' : (displayCrumbs(parent, t('browser.home')).at(-1)?.name ?? parent.path))

  const confirmCreate = (): void => {
    /* v8 ignore next -- reentry fence: the nested dialog only renders with a target and disables while creating. */
    if (targetPath === null || folderDraft === null || creatingFolder) return
    const name = folderDraft.trim()
    if (name === '') return
    setCreatingFolder(true)
    setCreateError(null)
    createDirectory(targetPath, name).then((createdPath) => {
      setCreatingFolder(false)
      setFolderDraft(null)
      // Land like a right-column pick (figma 802:57446 → 813:23278 flow): the
      // create target becomes the listed level and the new folder its selection.
      const seq = ++requestSeq.current
      setLoading(true)
      listDirectory(targetPath).then((level) => {
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

  if (!open) return null
  const twoPane = selected !== null

  return (
    <Modal
      open={open}
      // Escape and mask reach every mounted Modal's document listener; while
      // the nested create dialog is up, only that topmost dialog may close
      // (its own guard keeps an in-flight creation open).
      onClose={() => { if (folderDraft === null) onClose() }}
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
                <span className={css.crumbTrail} ref={crumbTrailRef}>
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.path} className={css.crumbSeat}>
                      {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                      <button
                        type="button"
                        className={css.crumb}
                        disabled={busy}
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
                  disabled={parent === null || busy}
                  /* v8 ignore next -- narrowing guard: the zone disables while the level is null. */
                  onClick={() => { if (parent !== null) setPathDraft(selected?.path ?? parent.path) }}
                />
              </>
            )
            : (
              <input
                className={css.pathInput}
                value={pathDraft}
                aria-label={t('browser.editPath')}
                autoFocus
                disabled={busy}
                onChange={(event) => { setPathDraft(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    const target = pathDraft.trim()
                    if (target !== '') navigate(target)
                  }
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setPathDraft(null)
                    setError(null)
                  }
                }}
              />
            )}
        </div>
      </div>
      <div className={css.content}>
        {parent !== null && (
          <LevelColumn
            entries={parent.entries}
            selectedPath={selected?.path ?? null}
            busy={busy}
            onPick={select}
            wide={!twoPane}
          />
        )}
        {twoPane && <span className={css.divider} />}
        {twoPane && child !== null && (
          <LevelColumn
            entries={child.entries}
            selectedPath={null}
            busy={busy}
            onPick={advance}
            wide={false}
          />
        )}
        {loading && <div className={css.status} role="status">{t('browser.loading')}</div>}
        {error !== null && <div className={css.error} role="alert">{error}</div>}
      </div>
      <div className={css.footerBar}>
        <Button
          variant="outline"
          icon={<IconPlusOutline16 size={14} />}
          disabled={parent === null || busy || loading || folderDraft !== null}
          onClick={() => {
            setFolderDraft('')
            setCreateError(null)
          }}
        >
          {t('browser.newFolder')}
        </Button>
        <span className={css.footerGap} />
        <Button variant="outline" className={clsx(css.footerAction)} disabled={busy} onClick={onClose}>{t('browser.cancel')}</Button>
        <Button
          variant="primary"
          className={clsx(css.footerAction)}
          disabled={targetPath === null || loading || busy}
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
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
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
