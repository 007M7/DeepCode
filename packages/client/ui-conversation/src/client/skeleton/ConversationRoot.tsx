// Resident conversation skeleton. Hero chrome, composer positioning, and the
// chain stay mounted across no-session/session transitions. Only the inert
// input body swaps for the strict session InputBar.

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps, InputZone } from '../contract/slots.ts'
import { HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
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

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  useEffect(() => {
    if (pendingWorkspaceId !== undefined
      && sessionWorkspace?.workspaceId === pendingWorkspaceId) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId])

  const hero = sessionId === undefined || (composerPhase === 'blank' && (openState === 'open' || openState === 'loading'))
  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  const heroWorkspaceRow = (
    <>
      <WorkspaceChip
        buttonRef={pickerAnchor}
        label={
          pendingWorkspace?.title
          ?? (sessionId === undefined
            ? workspaceLabel('')
            : sessionWorkspace?.title ?? workspaceLabel(cwd ?? ''))
        }
        menuOpen={pickerOpen}
        onClick={() => { setPickerOpen(open => !open) }}
      />
      {renderSlot('conversation.hero.workspace', {
        open: pickerOpen,
        anchorRef: pickerAnchor,
        onPick: (workspaceId) => {
          setPickerOpen(false)
          setPendingWorkspaceId(workspaceId)
          void selectWorkspace(workspaceId).catch(() => {
            setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
          })
        },
        onClose: () => { setPickerOpen(false) },
      })}
    </>
  )

  const inputBar = sessionId === undefined
    ? <DisabledInputBar />
    : renderSlot('conversation.composer.bar', {
        variant: hero ? 'hero' : 'composer',
        ...(hero ? { placeholder: 'Describe what you want to build' } : {}),
        overlay: renderSlot('conversation.input.overlay', {}),
        leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),
        rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
      })

  const composerBar = (
    <div className={clsx(css.composerStack, hero && css.composerHero)}>
      {hero && <HeroShell />}
      {hero && heroWorkspaceRow}
      {!hero && zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {!hero && zone !== undefined && renderSlot('conversation.composer.dock', zone)}
      {inputBar}
    </div>
  )

  return (
    <div className={css.root} data-phase={hero ? 'hero' : 'active'}>
      {/* Mounted for every real session, hero included: ConversationSession
          renders no chrome while blank but owns the draft-persistence mirror
          bind — unmounting it in the hero would lose pre-first-send text on
          a refresh or scope rebuild. */}
      {sessionId !== undefined && renderSlot('conversation.session', {})}
      {renderSlotChain(
        'conversation.composer',
        { interactions: pending },
        { fallback: composerBar, overlay: true },
      )}
    </div>
  )
}
