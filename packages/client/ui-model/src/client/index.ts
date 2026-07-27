/**
 * Model selection plugin, browser half — TWO entries over ONE per-session
 * directory owned by ModelService (`ctx.models`). The /model popupSelect
 * contribution and the composer's named `conversation.input.model` seat both
 * load the session's provider-grouped advisory directory (`session.models`)
 * and submit through `session.selectModel` via the same directory instance,
 * so the host-reported current target is the single fact both surfaces echo
 * — a switch made in either entry is what the other shows next. Failures
 * ride each entry's own retry surface (popup shell error/retry; seat menu
 * inline error) without forking the state.
 */
import type { ModelTarget, SessionModels } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandServiceContract, SelectOption } from '@deepseek-ai/dsh-client-ui-command/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.model seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelDirectoryState } from './directory.ts'
import { ModelService } from './service.ts'
import type { ModelSelectInjected } from './slots.ts'
import { ModelSelect } from './ModelSelect.tsx'

export { ModelDirectory } from './directory.ts'
export type { ModelDirectoryState } from './directory.ts'
export { ModelService } from './service.ts'
export type { ModelSelectInjected } from './slots.ts'

/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** Flatten the directory into popup rows; failure rows are listed for visibility but never selectable. */
function optionsOf(directory: SessionModels): SelectOption[] {
  const rows: SelectOption[] = []
  for (const group of directory.groups) {
    for (const model of group.models) {
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        detail: model.unlisted === true
          ? `${group.name} · 未列入目录`
          : model.description !== undefined ? `${group.name} · ${model.description}` : group.name,
        ...(directory.current.provider === group.id && directory.current.model === model.id
          ? { active: true } : {}),
      })
    }
  }
  for (const failure of directory.failures) {
    rows.push({ id: `failure/${failure.id}`, label: failure.name, detail: `目录加载失败：${failure.message}` })
  }
  return rows
}

/**
 * Resolve a picked row back to its target by matching against the loaded
 * groups (the same data the rows were built from — ids stay opaque).
 * @param state - the session's directory snapshot.
 * @param id - the picked row id.
 * @returns the row's target, or undefined for failure rows / stale ids.
 */
function targetOf(state: ModelDirectoryState, id: string): ModelTarget | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id) continue
      const sameRoute = state.current?.provider === group.id && state.current.model === model.id
      const reasoningEffort = sameRoute
        ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort
      return {
        provider: group.id,
        model: model.id,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      }
    }
  }
  return undefined
}

/** Required services: the contribution registry, the seat's slot registry, and the service's own faces. */
export const inject = ['command', 'connection', 'sessions', 'slots']

/**
 * Client plugin body: mount ModelService, then register the /model popup
 * contribution and the composer model seat over it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.plugin(ModelService)

  // Entry 1: the /model popupSelect over the shared directory.
  ctx.inject(['command', 'models'], (scope: ClientContext) => {
    const command = scope.get('command') as CommandServiceContract
    const models = scope.models
    scope.effect(() => command.register({
      name: 'model',
      description: 'Select the model for this conversation',
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async session => optionsOf(await models.directoryFor(session.sessionId).load()),
        onSelect: async (option, session) => {
          const directory = models.directoryFor(session.sessionId)
          const target = targetOf(directory.store.getSnapshot(), option.id)
          if (target === undefined) {
            throw new Error('this provider\'s catalog failed to load — pick a model from a loaded group')
          }
          await directory.select(target)
        },
      },
    }), 'ui-model: /model contribution')
  })

  // Entry 2: the composer's named model seat over the SAME directory.
  // Conditional mount: the seat is declared by the composer-bar entry; the
  // conversation service's presence is the registration-safe signal.
  ctx.inject(['slots', 'conversation', 'models'], (scope: ClientContext) => {
    const models = scope.models
    scope.effect(() => scope.slots.register({
      name: 'conversation.input.model',
      inject: (sessionId): ModelSelectInjected => {
        const directory = models.directoryFor(sessionId)
        return {
          directory: directory.store,
          load: () => { directory.load().catch(() => { /* surfaced on the store */ }) },
          select: (target: ModelTarget) => directory.select(target).then(() => true, () => false),
        }
      },
    }, ModelSelect), 'ui-model: composer model seat registration')
  })
}
