/** Page-local Session Intent hero. */
import { useRef, useState } from 'react'
import type { EmptyStateSlotProps } from '../contract/slots.ts'
import type { InputBarError } from './InputBar.tsx'
import { EmptyHero, WorkspaceChip } from './EmptyHero.tsx'

/** Full props composed from runtime projections, injected actions, and the declared picker slot. */
export type EmptyStateProps = EmptyStateSlotProps

export function EmptyState({
  useSessions,
  useWorkspaces,
  startSession,
  updateSessionPrompt,
  sendSession,
  renderSlot,
}: EmptyStateProps) {
  const intent = useSessions(state => state.intent)
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerAnchor = useRef<HTMLButtonElement>(null)
  if (intent === undefined) return null
  const workspaceId = intent.target.kind === 'workspace' ? intent.target.workspaceId : undefined
  const workspace = workspaceId === undefined
    ? undefined
    : workspaces.find(item => item.workspaceId === workspaceId)
  const workspaceLabel = intent.target.kind === 'workspace-intent'
    ? workspaceSnapshot.intent?.name ?? 'Workspace unavailable'
    : workspace?.title ?? 'Workspace unavailable'
  const workspaceIntent = workspaceSnapshot.intent
  const busy = intent.phase === 'connecting' || workspaceIntent?.phase === 'creating'
  const status = workspaceIntent?.phase === 'creating'
    ? 'Creating workspace…'
    : intent.phase === 'connecting'
      ? 'Creating session…'
      : workspaceSnapshot.phase === 'pending'
        ? 'Loading workspaces…'
        : undefined
  const error: InputBarError | null = workspaceIntent?.error !== undefined
    ? { op: 'workspace', message: `Workspace creation failed: ${workspaceIntent.error}` }
    : intent.error === undefined
      ? null
      : { op: 'session', message: `Session creation failed: ${intent.error.message}` }

  const workspaceRow = (
    <>
      <WorkspaceChip
        buttonRef={pickerAnchor}
        label={workspaceLabel}
        menuOpen={pickerOpen}
        onClick={() => { setPickerOpen(open => !open) }}
      />
      {renderSlot('conversation.empty.workspace', {
        open: pickerOpen,
        anchorRef: pickerAnchor,
        onPick: (workspaceId) => {
          setPickerOpen(false)
          startSession(workspaceId, intent.prompt)
        },
        onClose: () => { setPickerOpen(false) },
      })}
    </>
  )

  return (
    <EmptyHero
      workspaceRow={workspaceRow}
      draft={intent.prompt}
      disabled={busy}
      {...(status === undefined ? {} : { status })}
      error={error}
      onDraftChange={updateSessionPrompt}
      onSend={() => { sendSession() }}
    />
  )
}
