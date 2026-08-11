/**
 * Background-task plugin, browser half: contributes one session-header action
 * that renders this session's `ctx.tasks` records. The data arrives entirely
 * through the `tasksBySession` list mirror, so the plugin issues no RPC and
 * holds no state of its own beyond popover visibility.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { TaskListAction } from './TaskListAction.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type TaskKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-task list copy. */
    'task': TaskKey
  }
}

export type { TaskListActionProps } from './TaskListAction.tsx'

/** Required services for locale registration and header-slot contribution. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-task: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'task-list',
      // After the subagent catalog: session lineage reads before process work.
      order: 20,
      locale: NS,
    }, TaskListAction),
  )
}
