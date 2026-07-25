/**
 * Models settings section plugin, browser half. Registers the `models` nav
 * entry into the shell-declared `settings.section` list slot; the content
 * column is intentionally empty until model management lands. Export
 * discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ModelsSection } from './ModelsSection.tsx'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration goes through declaration-aware deferral.
 */
export const inject = ['slots', 'locale']

/**
 * Register the Models section once the `settings.section` declaration is on
 * the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register('settings.models', 'zh', { nav: '模型' }),
      ctx.locale.register('settings.models', 'en', { nav: 'Models' }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-models: nav copy dictionaries')
  // Declaration-aware registration; the LEDGER is the has-registered judge
  // (not a local flag): after an HMR collapse re-declares the slot, the
  // cascade already removed our entry, and a stale disposer must not block
  // the re-registration.
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    const tryRegister = (): void => {
      if (ctx.slots.spec('settings.section') === undefined) return
      if (ctx.slots.entries('settings.section').some(e => e.component === ModelsSection)) return
      dispose = ctx.slots.register({
        name: 'settings.section',
        id: 'models',
        order: 10,
        label: ctx.locale.bind('settings.models')('nav'),
      }, ModelsSection)
    }
    // Nav labels are registrant-localized: re-register on locale change so
    // the ledger carries fresh text (the version bump re-renders the shell).
    // Dispose-then-requery: after an HMR collapse the disposer is stale and
    // the ledger/spec re-check keeps this path an idempotent no-op.
    const offLocale = ctx.on('locale/change', () => {
      dispose?.()
      dispose = undefined
      tryRegister()
    })
    const unsubscribe = ctx.slots.subscribe('settings.section', () => { tryRegister() })
    tryRegister()
    return () => {
      offLocale()
      unsubscribe()
      dispose?.()
    }
  }, 'ui-settings-models: section registration')
}
