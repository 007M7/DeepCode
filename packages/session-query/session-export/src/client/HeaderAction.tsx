import type { ReactNode } from 'react'
import { IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionExportDialog, type SessionExportDialogProps } from './Dialog.tsx'
import css from './HeaderAction.module.css'

/**
 * Render the Session Header export capsule and its shared result dialog.
 * @param props - Session runtime, download controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionExportHeader(props: SessionExportDialogProps): ReactNode {
  const { sessionId, useSessionExport, request } = props
  const entry = useSessionExport(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'

  return (
    <>
      <button
        type="button"
        className={css.sessionLogButton}
        disabled={busy}
        aria-busy={busy}
        onClick={() => { void request(sessionId) }}
      >
        <span>Session log</span>
        <IconDownloadOutline16 size={12} />
      </button>
      <SessionExportDialog {...props} />
    </>
  )
}
