/**
 * Command UI plugin, browser half: CommandService (`ctx.command`) owning the
 * capability-keyed directory cache, the '/' command source, the client
 * contribution registry, and the per-session popupSelect controllers; the
 * popupSelect shell self-registers into conversation.input.overlay with
 * per-session resolution.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the 'conversation.input.overlay' SlotMap declaration (the
// key's owner) into this program so the overlay registration below typechecks
// against the real declaration — no runtime edge to ui-conversation.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CommandService } from './service.ts'
import type { PopupSelectInjected } from './PopupSelectView.tsx'
import { PopupSelectView } from './PopupSelectView.tsx'

export { CommandService } from './service.ts'
export { CommandDirectory } from './directory.ts'
export type { CommandDescriptor, DirectoryStatus } from './directory.ts'
export { filterOptions, PopupSelectController } from './popup.ts'
export type { PopupSelectDeps, PopupSpec, PopupState, TokenSegment } from './popup.ts'
export type { PopupSelectInjected } from './PopupSelectView.tsx'
export type {
  CommandContribution, CommandDecoration, CommandServiceContract, CommandUiSpec, SelectOption,
} from './contract.ts'

declare module 'cordis' {
  interface Context {
    command: CommandService
  }
}

/** Required services: the '/' source registry plus the scope + wire faces the service reads. */
export const inject = ['slash', 'sessions', 'connection']

/**
 * Client plugin body: mount the service, then register the popupSelect shell
 * into the input overlay once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.plugin(CommandService)
  // Conditional mount, same seam as ui-slash's MenuView registration:
  // 'conversation.input.overlay' is declared by the conversation composer
  // entry, and the conversation service's presence is the registration-safe
  // signal that the declaration is on the ledger.
  ctx.inject(['slots', 'conversation', 'command', 'sessions'], (scope: ClientContext) => {
    const command = scope.command
    const sessions = scope.sessions
    scope.effect(() => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'command-popup',
      order: 1,
      inject: (sessionId): PopupSelectInjected => {
        const actx = sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`ui-command: session "${String(sessionId)}" resolved no scope`)
        return { popup: command.popupFor(actx) }
      },
    }, PopupSelectView), 'ui-command: popupSelect overlay registration')
  })
}
