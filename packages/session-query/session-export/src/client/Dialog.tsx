import type { ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionExportDownloadState } from './controller.ts'
import { NS } from './locales.ts'

/** Browser operations and state injected into the Session Header contribution. */
export interface SessionExportDialogInjected {
  hooks: { sessionExport: ObservableSnapshot<SessionExportDownloadState> }
  request: (sessionId: SessionId) => Promise<void>
  dismiss: (sessionId: SessionId) => void
}

export type SessionExportDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionExportDialogInjected>

/**
 * Modal shared by the Session Header button and this browser's `/export` command.
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionExportDialog({
  sessionId, useSessionExport, dismiss, t,
}: SessionExportDialogProps) {
  const entry = useSessionExport(state => state.bySession[String(sessionId)])

  const status = entry?.status
  const open = entry?.open === true
  const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null
  const title = status === 'downloading'
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'downloading'
    ? t('dialog.preparingDescription')
    : status === 'success' ? t('dialog.successDescription') : error ?? t('dialog.commandFailed')

  return (
    <Modal
      open={open}
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={<Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>}
    />
  )
}
