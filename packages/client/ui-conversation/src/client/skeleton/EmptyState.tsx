/** Page-local Session Intent hero. */
import { useEffect, useRef, useState } from 'react'
import type { ComposerAttachment, EmptyStateSlotProps } from '../contract/slots.ts'
import type { InputBarError } from './InputBar.tsx'
import { EmptyHero, WorkspaceChip } from './EmptyHero.tsx'

/** Full props composed from runtime projections, injected actions, and the declared picker slot. */
export type EmptyStateProps = EmptyStateSlotProps

export function EmptyState({
  useSessions,
  useWorkspaces,
  startSession,
  updateSessionPrompt,
  createDraftImages,
  releaseDraftImage,
  releaseDraftImages,
  sendSession,
  renderSlot,
}: EmptyStateProps) {
  const intent = useSessions(state => state.intent)
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const [pickerOpen, setPickerOpen] = useState(false)
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([])
  const [preparing, setPreparing] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  useEffect(() => () => {
    releaseDraftImages(attachmentsRef.current)
  }, [releaseDraftImages])

  if (intent === undefined) return null
  const workspaceId = intent.target.kind === 'workspace' ? intent.target.workspaceId : undefined
  const workspace = workspaceId === undefined
    ? undefined
    : workspaces.find(item => item.workspaceId === workspaceId)
  const workspaceLabel = intent.target.kind === 'workspace-intent'
    ? workspaceSnapshot.intent?.name ?? 'Workspace unavailable'
    : workspace?.title ?? 'Workspace unavailable'
  const workspaceIntent = workspaceSnapshot.intent
  const busy = preparing || intent.phase === 'connecting' || workspaceIntent?.phase === 'creating'
  const status = workspaceIntent?.phase === 'creating'
    ? 'Creating workspace…'
    : intent.phase === 'connecting'
      ? 'Creating session…'
      : workspaceSnapshot.phase === 'pending'
        ? 'Loading workspaces…'
        : undefined
  const error: InputBarError | null = sendError !== null
    ? { op: 'send', message: sendError }
    : workspaceIntent?.error !== undefined
      ? { op: 'workspace', message: `Workspace creation failed: ${workspaceIntent.error}` }
      : intent.error === undefined
        ? null
        : { op: 'session', message: `Session creation failed: ${intent.error.message}` }

  const addImages = (files: readonly File[]): string | null => {
    setSendError(null)
    try {
      setAttachments(current => [...current, ...createDraftImages(files, current)])
      return null
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const removeImage = (id: string): void => {
    releaseDraftImage(id)
    setAttachments(current => current.filter(attachment => attachment.id !== id))
  }

  const submit = (): void => {
    if (preparing) return
    setPreparing(true)
    setSendError(null)
    void sendSession(attachments).then(() => {
      releaseDraftImages(attachments)
      setAttachments([])
    }).catch((error: unknown) => {
      setSendError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      setPreparing(false)
    })
  }

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
      attachments={attachments}
      disabled={busy}
      {...(status === undefined ? {} : { status })}
      error={error}
      onDraftChange={updateSessionPrompt}
      onAddImages={addImages}
      onRemoveAttachment={removeImage}
      onSend={submit}
    />
  )
}
