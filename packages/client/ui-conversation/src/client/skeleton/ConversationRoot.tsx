// Resident conversation skeleton. Hero chrome, composer positioning, and the
// chain stay mounted across no-session/session transitions. Only the inert
// input body swaps for the strict session InputBar.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps, InputZone } from '../contract/slots.ts'
import { HeroGlow, HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import { DisabledInputBar } from './DisabledInputBar.tsx'
import css from './ConversationRoot.module.css'

/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps

export function ConversationRoot({
  sessionId, useSession, useSessions, useWorkspaces, useInput,
  renderSlot, renderSlotChain, selectWorkspace,
}: ConversationRootProps) {
  const openState = useSession(s => s.openState)
  const composerPhase = useSession(s => s.composerPhase)
  const pending = useSession(s => s.pending) ?? []
  const session = useSession(s => s)
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const workspaces = useWorkspaces(s => s)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  // Publishes the seat's live height as --dsh-composer-height on the scroll
  // body so floating controls (ChatView back-to-bottom) clear the composer as
  // it grows. Callback ref, not an effect: the seat remounts when the tree
  // moves between the no-session and session paths. Stable identity so React
  // reattaches only on those remounts, not on every render.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
    })
    seatObserver.current.observe(seat)
  }, [])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  // Clear the pending pick once the session lands in it, or when the picked
  // workspace disappears from a ready list (deleted from the sidebar).
  useEffect(() => {
    if (pendingWorkspaceId === undefined) return
    if (sessionWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace])

  // While a session is still replaying (loading + blank) the hero/docked
  // choice is unknowable — render the composer hidden instead of flashing
  // the centered hero and snapping to the docked bar (or vice versa).
  const settling = sessionId !== undefined && composerPhase === 'blank' && openState === 'loading'
  const hero = sessionId === undefined || (composerPhase === 'blank' && openState === 'open')
  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // Flow optimization — worth a close PR review for code/boundary issues.
  // The chip is a selector; label resolution walks the flow top-down:
  //   1. a just-picked workspace (pending) → its title;
  //   2. cold start, no session yet → placeholder ("Choose workspace");
  //   3. the blank session's workspace is in the list → its title;
  //   4. list still loading → cwd folder name bridges so the title does not
  //      flash on refresh (empty cwd → placeholder);
  //   5. list ready but no owning workspace (deleted from the sidebar) →
  //      placeholder, never the deleted folder's name via cwd.
  const chipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : sessionWorkspace?.title
        ?? (workspaces.phase === 'ready' || cwd === undefined || cwd === ''
          ? undefined
          : workspaceLabel(cwd)))

  const heroWorkspaceRow = (
    <div className={css.heroWorkspaceRow}>
      <WorkspaceChip
        buttonRef={pickerAnchor}
        label={chipTitle}
        menuOpen={pickerOpen}
        onClick={() => { setPickerOpen(open => !open) }}
      />
      {renderSlot('conversation.hero.workspace', {
        open: pickerOpen,
        anchorRef: pickerAnchor,
        selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
        onPick: (workspaceId) => {
          setPickerOpen(false)
          setPendingWorkspaceId(workspaceId)
          void selectWorkspace(workspaceId).catch(() => {
            setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
          })
        },
        onClose: () => { setPickerOpen(false) },
      })}
    </div>
  )

  // The placeholder chip ("Choose workspace") and the inert input travel
  // together: a blank session whose workspace vanished (deleted from the
  // sidebar) reverts to the same disabled bar as the initial no-session state.
  const inputBar = sessionId === undefined || (hero && chipTitle === undefined)
    ? <DisabledInputBar />
    : renderSlot('conversation.composer.bar', {
      variant: hero ? 'hero' : 'composer',
      ...(hero ? { placeholder: 'Describe what you want to build' } : {}),
      overlay: renderSlot('conversation.input.overlay', {}),
      leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),
      rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
      // Stats band under the card, inside the bar's width column so both
      // share one constraint (composer.dock = stats-line family).
      footer: !hero && zone !== undefined ? renderSlot('conversation.composer.dock', zone) : null,
    })

  const composerBar = (
    <div className={clsx(css.composerStack, hero && css.composerHero)}>
      {hero && <HeroGlow className={css.heroGlow} />}
      {hero && <HeroShell />}
      {hero && heroWorkspaceRow}
      {!hero && zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {inputBar}
    </div>
  )

  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  const composer = renderSlotChain(
    'conversation.composer',
    { interactions: pending },
    { fallback: composerBar, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave Question/Approval panels at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      {composer}
    </div>
  )

  // Header stays column chrome above this scrollport; the sticky composer
  // seat lives inside it with the transcript. Always wrap while a session
  // exists (hero/settling/active) so the composer keeps one tree seat across
  // the blank → active flip — relocating it only in active remounted the textarea.
  const wrapActiveBody = (view: ReactNode): ReactNode => (
    <div className={css.scrollBody} data-conversation-scroll="">
      {view}
      {composerSeat}
    </div>
  )

  return (
    <div className={css.root} data-phase={phase}>
      {/* Mounted for every real session, hero included: ConversationSession
          keeps a chrome-hidden shell while blank and owns the draft-
          persistence mirror bind — unmounting it in the hero would lose
          pre-first-send text on a refresh or scope rebuild. */}
      {sessionId !== undefined && renderSlot(
        'conversation.session',
        { wrapActiveBody },
      )}
      {sessionId === undefined ? composerSeat : null}
    </div>
  )
}
