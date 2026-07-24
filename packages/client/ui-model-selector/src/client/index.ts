/**
 * Browser model-selector plugin: registers one session-scoped occupant in the
 * conversation composer-control slot. The Session object owns all catalog and
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
    name: 'conversation.composer.control',
    inject: (sessionId: SessionId): ModelSelectorInjected => {
      const session = sessions.manager.get(sessionId)
      return {
        refreshModels: () => { void session.refreshModels() },
        retryModelOperation: () => session.retryModelOperation(),
        selectModel: async target => (await session.selectModel(target)).ok,
      }
    },
  }, ModelSelector)
}
