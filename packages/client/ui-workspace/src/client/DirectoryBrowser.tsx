/**
 * The in-app workspace-directory browser (figma Harness 802-56979): breadcrumb
 * header with a click-to-edit path zone, one navigable directory level, an
 * inline New-folder row, and the Cancel/Open footer. Pure consumer of the
 * injected browse calls — the owning flow decides what "Open" means and owns
 * the workspace-creation error surface. Hidden entries are host-flagged and
 * filtered here (a show-hidden toggle is deferred work, client-side only).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronRightOutline14, IconFolderClose16, IconPlusOutline16, Modal,
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
  /** Create one child directory under the listed level. */
  createDirectory: (path: string, name: string) => Promise<string>
  /** The operator confirmed the currently listed directory. */
  onOpen: (path: string) => void
  /** Close without picking (mask, Escape, Cancel). */
  onClose: () => void
  /** The owner's confirm is in flight: Open disables, the level freezes. */
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

/**
 * Render the directory-browser dialog.
 * @param props - owner-controlled browser props.
 * @returns the dialog element (null while closed, via Modal).
 */
export function DirectoryBrowser({ open, listDirectory, createDirectory, onOpen, onClose, busy, t }: DirectoryBrowserProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Path-edit state: null = breadcrumb mode; a string = the draft being typed.
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  // New-folder state: null = no inline row; a string = the name being typed.
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const requestSeq = useRef(0)

  const navigate = useCallback((path?: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    listDirectory(path).then((next) => {
      if (seq !== requestSeq.current) return
      setListing(next)
      setLoading(false)
      setPathDraft(null)
      setFolderDraft(null)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
    })
  }, [listDirectory])

  // Every open starts fresh at the Host home directory; closing invalidates
  // any in-flight response so a late arrival cannot repopulate a closed dialog.
  useEffect(() => {
    if (open) {
      setListing(null)
      navigate()
      return
    }
    requestSeq.current += 1
    setError(null)
    setPathDraft(null)
    setFolderDraft(null)
  }, [open, navigate])

  const confirmFolder = (): void => {
    if (listing === null || folderDraft === null || creatingFolder) return
    const name = folderDraft.trim()
    if (name === '') return
    setCreatingFolder(true)
    setError(null)
    createDirectory(listing.path, name).then(() => {
      setCreatingFolder(false)
      setFolderDraft(null)
      navigate(listing.path)
    }, (reason: unknown) => {
      setCreatingFolder(false)
      setError(failureText(reason))
    })
  }

  // After the hooks: a closed dialog renders nothing and evaluates no copy.
  if (!open) return null

  const crumbs = listing === null ? [] : displayCrumbs(listing, t('browser.home'))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('browser.title')}
      className={clsx(css.dialog)}
      footer={(
        <div className={css.footerBar}>
          <Button
            variant="outline"
            icon={<IconPlusOutline16 size={14} />}
            disabled={listing === null || busy || folderDraft !== null}
            onClick={() => { setFolderDraft('') }}
          >
            {t('browser.newFolder')}
          </Button>
          <span className={css.footerGap} />
          <Button variant="outline" className={css.footerAction} disabled={busy} onClick={onClose}>{t('browser.cancel')}</Button>
          <Button
            variant="primary"
            className={css.footerAction}
            disabled={listing === null || loading || busy}
            onClick={() => { if (listing !== null) onOpen(listing.path) }}
          >
            {t('browser.open')}
          </Button>
        </div>
      )}
    >
      <div className={css.crumbBar}>
        {pathDraft === null
          ? (
            <>
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
              {/* The empty zone right of the crumbs is the path-edit affordance. */}
              <button
                type="button"
                className={css.crumbEditZone}
                aria-label={t('browser.editPath')}
                disabled={listing === null || busy}
                onClick={() => { if (listing !== null) setPathDraft(listing.path) }}
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
      <div className={css.level} role="list" aria-label={t('browser.title')}>
        {folderDraft !== null && listing !== null && (
          <div className={clsx(css.row, css.folderRow)}>
            <IconFolderClose16 size={16} className={css.rowIcon} />
            <input
              className={css.folderInput}
              value={folderDraft}
              aria-label={t('browser.newFolder')}
              placeholder={t('browser.folderName')}
              autoFocus
              disabled={creatingFolder}
              onChange={(event) => { setFolderDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  confirmFolder()
                }
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setFolderDraft(null)
                }
              }}
            />
          </div>
        )}
        {listing?.entries.filter(entry => !entry.hidden).map(entry => (
          <button
            key={entry.path}
            type="button"
            role="listitem"
            className={css.row}
            disabled={busy}
            onClick={() => { navigate(entry.path) }}
          >
            <IconFolderClose16 size={16} className={css.rowIcon} />
            <span className={css.rowName}>{entry.name}</span>
            <IconChevronRightOutline14 size={12} className={css.rowChevron} />
          </button>
        ))}
        {loading && <div className={css.status} role="status">{t('browser.loading')}</div>}
        {error !== null && <div className={css.error} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
