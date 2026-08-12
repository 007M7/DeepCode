/** Browser plugin owning Session export download state and its shared modal. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-command/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionExportDownloadController } from './controller.ts'
import type { SessionExportDialogInjected } from './Dialog.tsx'
import { SessionExportHeader } from './HeaderAction.tsx'
import { en, NS, zh, type SessionExportKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionExport: SessionExportDownloadController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-export': SessionExportKey
  }
}

export type { SessionExportDownloadEntry, SessionExportDownloadState } from './controller.ts'

export const inject = ['slots', 'locale']

/**
 * Provide the download controller and mount its modal into the Session Header.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionExportDownloadController()
  ctx.provide('sessionExport', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-export: browser download lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-export: browser dictionaries')
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName === 'export' && result.kind === 'success') void controller.download(sessionId)
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-export',
    locale: NS,
    inject: (): SessionExportDialogInjected => ({
      hooks: { sessionExport: controller.store },
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
    }),
  }, SessionExportHeader))
}

export type { SessionExportDialogInjected, SessionExportDialogProps } from './Dialog.tsx'
