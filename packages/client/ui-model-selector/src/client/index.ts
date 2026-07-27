/**
 * Browser model-selector plugin: registers one session-scoped occupant in the
 * conversation model-control slot. The Session object owns all catalog and
 * selection state; the component receives only the standard snapshot hook and
 * injected callbacks.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelSelectorInjected } from './contract.ts'
import { ModelSelector } from './ModelSelector.tsx'

export type { ModelSelectorInjected, ModelSelectorProps } from './contract.ts'

/** Required services; conversation is the slot-declaration ordering edge. */
export const inject = ['slots', 'sessions', 'conversation']

/**
 * Register the model selector in the resident conversation composer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions
  ctx.slots.register({
    name: 'conversation.input.model',
    inject: (sessionId: SessionId): ModelSelectorInjected => {
      const binding = sessions.binding(sessionId)
      if (binding === undefined) {
        throw new Error(`ui-model-selector: session "${sessionId}" resolved no binding`)
      }
      const { session } = binding
      return {
        refreshModels: () => { void session.refreshModels() },
        retryModelOperation: () => session.retryModelOperation(),
        selectModel: async target => (await session.selectModel(target)).ok,
      }
    },
  }, ModelSelector)
}
