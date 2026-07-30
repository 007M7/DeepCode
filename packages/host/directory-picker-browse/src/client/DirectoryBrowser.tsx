/**
 * The in-app workspace-directory browser (figma Harness 813-23126 family): a
 * 680×500 dialog (clamped to short/narrow viewports — the Miller row scrolls
 * sideways, the columns scroll down) whose header carries the title, the selection-path
 * breadcrumb, and a click-to-edit path zone; below it a Miller view — one
 * full-width level until a row is selected, then two columns splitting the
 * row evenly (256px floor; level | selected folder's children) around a
 * hairline divider. Navigations land selection-anchored and quiet: the
 * previous view keeps rendering while a crumb jump or a submitted path is
 * scanned, then target and parent legs land as one two-pane frame (a slow
 * parent leg falls back to landing the target alone and upgrading in
 * place), so stepping back keeps two panes away from the display root and
 * navigation never flashes an intermediate frame. Selecting in the
 * right column shifts the view one level deeper. "New folder" opens a nested
 * create dialog targeting the selected folder (or the level itself) and
 * selects the created folder. Open adopts the selected folder, falling back
 * to the listed level. Pure consumer of the injected browse calls — the
 * owning flow decides what "Open" means and owns the workspace-creation
 * error surface. Hidden entries are host-flagged and hidden by default; the
 * footer's fixed-label "Show hidden files" toggle (aria-pressed, check when
 * on) reveals them (client-side only). The path editor opens seeded with a
 * trailing separator, and while the draft's directory part names a listed
 * level, its final segment prefix-filters that level's rows (a dot-led
 * prefix also reveals the hidden entries it names).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutline16, IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16, IconPlusOutline16, Modal,
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
 * How long a scan may stay visually silent before the floating "Loading…"
 * pill appears. The stale view keeps rendering while a scan is in flight, so
 * a listing that settles inside this window swaps the panes with no
 * intermediate frame at all; only a genuinely slow host (a network mount, a
 * cold disk) surfaces the indicator.
 */
const SLOW_SCAN_DELAY_MS = 300

/**
 * How long a navigation landing waits for its parent leg before committing
 * the target alone. Inside the window both legs land as ONE two-pane frame —
 * no single-pane flash between them; past it the target commits single-pane
 * at once (an Enter-submitted navigation is never held hostage by a stalled
 * parent) and the late parent leg upgrades the landing in place.
 */
const PARENT_LEG_WAIT_MS = 200

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
 * The listing's platform separator, inferred from the home path the host
 * stamped — never from typed text or entry paths, where a backslash is a
 * legal POSIX name character. Still a heuristic at the last step: a POSIX
 * home directory whose own name contains a backslash would misread.
 * TODO: replace with a host-stamped `separator` field on the wire
 * DirectoryListing so the platform fact travels verbatim (the trade-off is
 * recorded in the directory-picker capability seam Agent Note).
 */
function separatorOf(listing: DirectoryListing): '\\' | '/' {
  return listing.home.includes('\\') ? '\\' : '/'
}

/**
 * The path draft's final segment, when its directory part is exactly the
 * level `listing` lists — the segment the level prefix-filters on while the
 * user types. Any other draft (no separator yet, or naming some other
 * directory) leaves the level unfiltered. The directory part compares
 * exactly (it is the host's own path text, reached by seeding or erasing);
 * only the name filter downstream is case-insensitive.
 */
function draftPrefixFor(listing: DirectoryListing, draft: string | null): string | null {
  if (draft === null) return null
  const sep = separatorOf(listing)
  const cut = draft.lastIndexOf(sep)
  if (cut === -1) return null
  const level = listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`
  return draft.slice(0, cut + 1) === level ? draft.slice(cut + 1) : null
}

/** One column of folder rows (the Miller view renders one or two of these). */
function LevelColumn({ entries, selectedPath, busy, onPick, showHidden, filterPrefix, pathEditing }: {
  entries: readonly DirectoryEntry[]
  selectedPath: string | null
  busy: boolean
  onPick: (entry: DirectoryEntry) => void
  showHidden: boolean
  filterPrefix: string | null
  pathEditing: boolean
}) {
  const visible = entries.filter((entry) => {
    // The selection is exempt from both filters: it anchors the two-pane
    // view (crumbs and the child pane point at it), so neither the hidden
    // filter after a dot-reveal pick nor a prefix miss may orphan it.
    if (entry.path === selectedPath) return true
    if (filterPrefix !== null && !entry.name.toLowerCase().startsWith(filterPrefix.toLowerCase())) return false
    // A dot-led prefix names hidden entries explicitly, so matching ones
    // surface even while the toggle keeps the rest hidden.
    return showHidden || !entry.hidden || filterPrefix?.startsWith('.') === true
  })
  return (
    <div className={css.column} role="list">
      {visible.map((entry) => {
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
              // While the path editor is open, keep focus in it: a focus
              // steal on mousedown would blur the editor and (in engines
              // where the blur lands before our guards) drop this click.
              // Outside editing, rows keep native focus behavior.
              onMouseDown={pathEditing ? (event) => { event.preventDefault() } : undefined}
              // Editing-time focus parking happens after commit (the
              // DirectoryBrowser refocus effect): a right-pane pick replaces
              // this very column, so focusing the clicked node here would
              // still fall to body.
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
  // Derived from `loading` and `scanWindow` by the slow-scan effect below:
  // true only once the current listing call has been in flight for
  // SLOW_SCAN_DELAY_MS, so fast listings never render the indicator at all.
  const [slowScan, setSlowScan] = useState(false)
  // Every listing call owns a fresh silence window. `loading` may stay true
  // across a superseding row pick or across a navigation's target and parent
  // legs, so its boolean edge cannot identify the start of each scan.
  const [scanWindow, setScanWindow] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Path-edit state: null = breadcrumb mode; a string = the draft being typed.
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  // Show-hidden toggle state (pure client-side filter, reset on each open).
  const [showHidden, setShowHidden] = useState(false)
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

  /** Hide any prior indicator and start a fresh silence window for one listing call. */
  const restartSlowScanWindow = useCallback((): void => {
    setSlowScan(false)
    setScanWindow(value => value + 1)
  }, [])

  /** Launch one listing under a fresh controller so a later supersession can abort it. */
  const launchListing = useCallback((path: string | undefined): { seq: number; scan: Promise<DirectoryListing> } => {
    const seq = supersede()
    const controller = new AbortController()
    scanController.current = controller
    restartSlowScanWindow()
    return { seq, scan: listDirectory(path, controller.signal) }
  }, [supersede, restartSlowScanWindow, listDirectory])

  /**
   * Launch a follow-up listing under the CURRENT supersession seq: a newer
   * intent aborts it like the leg it continues, and it supersedes nothing.
   */
  const continueScan = useCallback((path: string): Promise<DirectoryListing> => {
    const controller = new AbortController()
    scanController.current = controller
    restartSlowScanWindow()
    return listDirectory(path, controller.signal)
  }, [restartSlowScanWindow, listDirectory])

  /**
   * Replace the whole view with a freshly navigated level. Away from the
   * display root — the same collapse the crumb header renders, so crumbs and
   * pane shape never disagree — the landing is two-pane: the target's ACTUAL
   * parent-level entry re-selected (left pane = parent, right pane = the
   * target), so a crumb jump reads as stepping back one pane. Both legs land
   * as one frame when the parent leg settles within
   * {@link PARENT_LEG_WAIT_MS}; past that bound (or at the display root) the
   * target commits alone — single wide level, the editor closes, loading
   * ends — and a late parent leg still upgrades the landing in place. A
   * failed parent leg, or a truncated parent window that lacks the target,
   * leaves the single-pane landing — the upgrade must never orphan the
   * selection it exists to anchor. Until whichever commit comes first, the
   * previous view keeps rendering: navigation swaps the panes, it never
   * blanks them.
   */
  const navigate = useCallback((path?: string) => {
    const { seq, scan } = launchListing(path)
    setLoading(true)
    setError(null)
    scan.then((target) => {
      if (seq !== requestSeq.current) return
      // The single-pane landing; `landed` makes it first-commit-only, while
      // the two-pane commit below may still upgrade an already-landed view.
      let landed = false
      const landSingle = (): void => {
        if (landed || seq !== requestSeq.current) return
        landed = true
        setParent(target)
        setSelected(null)
        setChild(null)
        setLoading(false)
        setPathDraft(null)
      }
      // Arity is label-independent: only the collapsed chain's depth decides.
      if (displayCrumbs(target, '').length < 2) { landSingle(); return }
      const parentCrumb = target.crumbs.at(-2)
      /* v8 ignore next -- narrowing: a two-deep display chain implies a parent crumb (root-to-target inclusive). */
      if (parentCrumb === undefined) { landSingle(); return }
      continueScan(parentCrumb.path).then((parentLevel) => {
        if (seq !== requestSeq.current) return
        // Windows resolves a typed path preserving its case; anchor on the
        // parent level's actual entry so selection comparisons hold.
        const sep = separatorOf(parentLevel)
        const fold = (value: string): string => (sep === '\\' ? value.toLowerCase() : value)
        const match = parentLevel.entries.find(entry => fold(entry.path) === fold(target.path))
        if (match === undefined) { landSingle(); return }
        landed = true
        setParent(parentLevel)
        setSelected(match)
        setChild(target)
        // Idempotent on a late upgrade of a timed-out landing: reopening the
        // editor or starting a newer scan supersedes this seq, so reaching
        // here means the draft is closed and the loading flag is this
        // navigation's own.
        setLoading(false)
        setPathDraft(null)
      }, () => {
        // The parent-leg failure (its abort included) never surfaces: the
        // target listed fine, and nobody asked to see the parent level.
        landSingle()
      })
      window.setTimeout(landSingle, PARENT_LEG_WAIT_MS)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
    })
  }, [launchListing, continueScan])

  // Editor-close focus parking (consumed by the refocus effect below the
  // miller-row ref): a pick parks on the selection's row, Enter and an
  // input-focused Escape park on the crumb edit zone that replaces the
  // input. Pointer-out cancels never set (or clear) these — yanking focus
  // back from wherever the user clicked would be worse than the fall.
  const refocusPick = useRef(false)
  const refocusEditZone = useRef(false)
  const pathInputRef = useRef<HTMLInputElement | null>(null)
  const editZoneRef = useRef<HTMLButtonElement | null>(null)

  /**
   * Select a row of the listed level and preview its children on the right.
   * Deliberately NOT one-frame like navigate(): a pick's first duty is the
   * immediate selected state on the clicked row, and the pane split IS that
   * feedback (aria-current pill, crumbs following the selection) — holding
   * it back for the child listing would make clicks feel dropped. The quiet
   * rule governs whole-view replacement, where nothing acknowledges the
   * click but the swap itself.
   */
  const select = useCallback((entry: DirectoryEntry) => {
    const { seq, scan } = launchListing(entry.path)
    // A pick while the path editor is open adopts the (filtered) row and
    // closes the editor — the draft served its purpose. Focus re-parks on
    // the selection after commit (see the refocus effect below).
    if (pathDraft !== null) refocusPick.current = true
    setPathDraft(null)
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
      // Clearing the selection can unmount the very row the pick parked
      // focus on (a dot-revealed hidden row re-hides); the refocus effect
      // re-parks on the edit zone only if focus actually fell to body.
      refocusEditZone.current = true
    })
  }, [launchListing, pathDraft])

  /** Abandon path editing (Escape or clicking away) and restore the crumb view. */
  const cancelPathEdit = useCallback(() => {
    // Cancel also withdraws a navigation the editor already launched: its
    // late success must not jump to the cancelled path, so the pending
    // request is superseded and the view leaves the loading state.
    supersede()
    setLoading(false)
    setPathDraft(null)
    setError(null)
    // Editing may have superseded the selection's preview request; a
    // selection with no preview would render a half-empty two-pane view, so
    // cancel falls back to the single-pane level.
    if (child === null) setSelected(null)
    // With no level listed yet (the editor superseded the initial home
    // listing), plain cancellation would leave a permanently blank picker:
    // restart the home listing.
    if (parent === null) navigate()
  }, [supersede, child, parent, navigate])

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
      setShowHidden(false)
      navigate()
      return
    }
    supersede()
    // Closing mid-scan leaves nothing to load: without this edge the
    // slow-scan effect keeps arming while hidden and the reopened dialog
    // would show the indicator on its first frame instead of waiting out a
    // fresh silence window (reopen's navigate() produces no loading edge).
    setLoading(false)
    setError(null)
    setPathDraft(null)
    setFolderDraft(null)
    setCreateError(null)
    // A close mid-flight (failed Enter, then Cancel) may leave refocus
    // flags armed; retire them so a later render cannot consume them.
    refocusPick.current = false
    refocusEditZone.current = false
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
      // Symmetric with navigate/select: a launched scan clears the stale
      // failure text (and keeps the floating indicator's corner the only
      // occupant of the content's right edge while it shows).
      setError(null)
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

  // The slow-scan gate for the loading indicator: each listing call restarts
  // the timer even when a superseding scan or a navigation's parent leg keeps
  // `loading` continuously true. A settle inside its own window means the swap
  // happened with nothing shown.
  useEffect(() => {
    if (!loading) {
      setSlowScan(false)
      return
    }
    const timer = window.setTimeout(() => { setSlowScan(true) }, SLOW_SCAN_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [loading, scanWindow])

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
  // Every editor exit that would drop focus to body re-parks it after
  // commit, so keyboard traversal stays inside the dialog (the Modal has no
  // focus trap): a pick lands on the selection's row — aria-current in the
  // freshly rendered left pane, which survives even a right-pane advance
  // replacing the picked button's column — while Enter and an input-focused
  // Escape land on the crumb edit zone that replaces the input.
  useEffect(() => {
    if (pathDraft !== null) return
    if (refocusPick.current) {
      refocusPick.current = false
      refocusEditZone.current = false
      const rowHost = millerRowRef.current
      /* v8 ignore next -- narrowing guard: the miller row is mounted whenever a pick just committed. */
      if (rowHost === null) return
      const row = rowHost.querySelector<HTMLButtonElement>('button[aria-current="true"]')
      /* v8 ignore next -- narrowing guard: the pick that set the flag just rendered its aria-current row. */
      if (row === null) return
      row.focus()
      return
    }
    if (refocusEditZone.current) {
      refocusEditZone.current = false
      // Re-park only when the close actually dropped focus to body; focus
      // the user parked elsewhere (a surviving row) stays theirs.
      if (document.activeElement !== document.body) return
      const zone = editZoneRef.current
      /* v8 ignore next -- narrowing guard: crumb mode renders the edit zone whenever the editor just closed. */
      if (zone === null) return
      zone.focus()
    }
  })

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
      {/* Path-edit cancellation is observed at the card scope, not the
        * input: once Tab parks focus on a filtered row the input is off the
        * event path, yet Escape must still collapse the editor (not the
        * dialog) and a further focus move out of the card must still
        * cancel. display:contents keeps header/content/footer as direct
        * flex children of the Modal card. */}
      <div
        className={css.editorScope}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pathDraft === null) return
          // stopPropagation keeps the card-scope Escape from the Modal's
          // document listener — the same containment the input previously
          // provided for itself.
          event.stopPropagation()
          // Escape while the input holds focus is about to unmount it; with
          // focus already parked on a row, that row survives the cancel and
          // keeps focus naturally. Assignment (not a conditional set) also
          // retires a stale flag a failed or still-upgrading Enter left.
          refocusEditZone.current = document.activeElement === pathInputRef.current
          cancelPathEdit()
        }}
        // Focus leaving THIS dialog card while editing cancels like Escape.
        // Guarded non-cancel paths: window/tab focus loss (document no
        // longer focused); a focus move that stays inside the card (Tab
        // onto the filtered rows or the footer toggle); and pointer paths,
        // where rows and the toggle suppress focus steal on mousedown while
        // editing so their click lands first. Enter keeps focus in the
        // input while its navigation is in flight, so a submitted path is
        // never withdrawn here. Anchored to this card via closest, not any
        // [role="dialog"], so focus escaping into a sibling overlay cancels.
        onBlur={(event) => {
          if (pathDraft === null) return
          if (!document.hasFocus()) return
          const card = event.currentTarget.closest('[role="dialog"]')
          /* v8 ignore next -- narrowing guard: this scope always renders inside the Modal card. */
          if (card === null) return
          if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return
          // The user moved focus out of the card themselves: cancel without
          // re-parking (a lingering Enter-failure flag must not yank focus
          // back either).
          refocusEditZone.current = false
          cancelPathEdit()
        }}
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
                    ref={editZoneRef}
                    onClick={() => {
                    // Opening the editor supersedes any pending listing: a
                    // settlement landing before the first keystroke would
                    // otherwise close the editor via navigate's draft reset.
                      supersede()
                      setLoading(false)
                      // Seed with a trailing separator so typing immediately
                      // continues into child names (and prefix-filters below).
                      // No listed level means nothing to seed from (the editor
                      // is the recovery path for a failed home listing).
                      if (parent === null) {
                        setPathDraft('')
                        return
                      }
                      const base = selected?.path ?? parent.path
                      const sep = separatorOf(parent)
                      setPathDraft(base.endsWith(sep) ? base : `${base}${sep}`)
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
                  ref={pathInputRef}
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
                  // Escape and focus-leave cancellation live on the card-scope
                  // wrapper above (they must work after focus Tabs onto the
                  // rows); this handler owns only submission.
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !composingRef.current) {
                      event.preventDefault()
                      // Trim only detects a blank draft; the Host gets the
                      // original text — a real directory name may end in
                      // whitespace, and trimming would list its sibling.
                      if (pathDraft.trim() !== '') {
                        // Success will unmount the still-focused input; park
                        // focus on the returning crumb edit zone (a failure
                        // keeps the editor, so the flag waits until close).
                        refocusEditZone.current = true
                        navigate(pathDraft)
                      }
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
                showHidden={showHidden}
                filterPrefix={draftPrefixFor(parent, pathDraft)}
                pathEditing={draftPending}
              />
            )}
            {twoPane && <span className={css.divider} />}
            {twoPane && child !== null && (
              <LevelColumn
                entries={child.entries}
                selectedPath={null}
                busy={parentInert}
                onPick={advance}
                showHidden={showHidden}
                filterPrefix={draftPrefixFor(child, pathDraft)}
                pathEditing={draftPending}
              />
            )}
          </div>
          {loading && slowScan
          && <div className={clsx(css.status, css.loadingFloat)} role="status">{t('browser.loading')}</div>}
          {/* The backend bounds a level at its complete-result limit; say so
          * whenever a visible pane was cut instead of letting the tail of a
          * huge directory go silently missing. The note describes the panes
          * on screen, so an in-flight scan leaves it alone — hiding it while
          * the stale view still shows the cut level would shift the columns
          * on every navigation away from it. */}
          {(parent?.truncated === true || child?.truncated === true)
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
          <button
            type="button"
            className={clsx(css.showHiddenToggle, showHidden && css.showHiddenToggleActive)}
            aria-pressed={showHidden}
            disabled={parentInert}
            // The toggle composes with the path editor (dot-led prefixes and
            // this filter interleave): while editing, don't steal focus, so
            // toggling never blur-cancels a draft mid-thought. Outside editing
            // it keeps native focus behavior.
            onMouseDown={draftPending ? (event) => { event.preventDefault() } : undefined}
            onClick={() => { setShowHidden(prev => !prev) }}
          >
            {t('browser.showHidden')}
            {/* Trailing check (Menu's selected vocabulary): the label never
              * shifts when the pressed state toggles. */}
            {showHidden && <IconCheckOutline16 size={14} />}
          </button>
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
