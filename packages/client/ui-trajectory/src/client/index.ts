/**
 * Browser trajectory plugin contributing one entry to the conversation view
 * slot without defining a service.
 */
import type { Context } from 'cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createTrajectoryDurationStore } from './duration-store.ts'
import { TrajectoryView, type TrajectoryViewInjected } from './TrajectoryView.tsx'
import { en, NS, zh } from './locales.ts'
import { downloadBytes, sessionLogZipFilename } from './export-log.ts'

/** Required services: the conversation view slot, the independent history source, and the locale service. */
export const inject = ['slots', 'sessionHistory', 'locale']

/**
 * Client plugin body: register the trajectory view tab. The registration
 * rides the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-trajectory: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  const duration = createTrajectoryDurationStore()
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'trajectory',
    order: 10,
    label: () => t('view.trajectory'),
    inject: (sessionId: SessionId): TrajectoryViewInjected => {
      const history = ctx.sessionHistory.source(sessionId)
      return {
        hooks: { history, duration },
        loadHistoryTail: signal => history.loadTail(signal),
        loadOlderHistory: signal => history.loadOlder(signal),
        setActualDuration: (value) => { duration.set(value) },
        exportLog: async () => {
          // The host streams the ZIP (root + descendant artifacts verbatim)
          // from GET /api/session.export; the browser downloads the response.
          const url = new URL('/api/session.export', window.location.origin)
          url.searchParams.set('sessionId', sessionId)
          url.searchParams.set('includeDescendants', 'true')
          const response = await fetch(url)
          if (!response.ok) {
            const detail = await response.text().catch(() => '')
            throw new Error(`导出失败：HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
          }
          const blob = await response.blob()
          downloadBytes(
            new Uint8Array(await blob.arrayBuffer()),
            sessionLogZipFilename(sessionId),
            'application/zip',
          )
        },
      }
    },
  }, TrajectoryView))
}
