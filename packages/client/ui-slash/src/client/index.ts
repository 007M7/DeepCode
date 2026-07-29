/**
 * Slash trigger plugin, browser half: the SlashService (`ctx.slash`) owning
 * trigger detection, the candidate menu, and the pick pipeline; MenuView
 * self-registers into the conversation.input.overlay slot. Frozen pipeline
 * contract in ./contract.ts; sources register through ctx.slash alone.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SlashService } from './service.ts'
import type { MenuViewInjected } from './slots.ts'
import { MenuView } from './MenuView.tsx'

export { SlashService } from './service.ts'
export { SlashController } from './controller.ts'
export type { SlashControllerDeps, SourceRoster } from './controller.ts'
export type { MenuViewInjected } from './slots.ts'
export type {
  ArbitrateKey, ArbitrateOutcome, BeginCommandRequest, CandidateRequest, ClientSessionContext,
  CommandClaim, ConsumeTokenRequest, InsertReferenceRequest, PickOutcome, PickVia, ReferenceCodec,
  ReferenceInsert, SlashCandidate, SlashPick, SlashSource, SubmitOutcome, TokenSpan,
  TriggerChar, TriggerGuard, TriggerPosition,
} from '../types.ts'
export type { DetectTrigger, ExactMatch, MenuEvent, MenuReduce, MenuState, TriggerHit } from '../core/contract.ts'
export type { SlashServiceContract } from './contract.ts'

declare module 'cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    slash: import('./contract.ts').SlashServiceContract
  }
}

/** Namespace owning the candidate-menu copy: group titles keyed by source name plus the pending row. */
const MENU_NS = 'slash.menu'

/** Required services: controller resolution reads the session scope tree; the menu copy is localized. */
export const inject = ['sessions', 'locale']

/**
 * Client plugin body: mount the service, then register MenuView into the
 * input overlay once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.plugin(SlashService)
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(MENU_NS, 'zh', { command: '命令', skill: '技能', subagent: '子智能体', loading: '正在加载…' }),
      ctx.locale.register(MENU_NS, 'en', { command: 'Commands', skill: 'Skills', subagent: 'Subagents', loading: 'Loading…' }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-slash: menu dictionaries')
  // Conditional mount: 'conversation.input.overlay' is declared by the
  // conversation composer entry, and the conversation service is mounted
  // after that declaration lands on the ledger — its presence is the
  // registration-safe signal (same seam as toolview registrants).
  ctx.inject(['slots', 'conversation', 'slash', 'sessions'], (scope: ClientContext) => {
    const slash = scope.slash
    const sessions = scope.sessions
    scope.effect(() => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'slash-menu',
      order: 0,
      inject: (sessionId): MenuViewInjected => {
        // Session-scoped slot: resolve this session's controller (the slot
        // frame hands ids, not ctx — the registered id→ctx interchange).
        const actx = sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`ui-slash: session "${String(sessionId)}" resolved no scope`)
        const controller = slash.sessionOf(actx)
        return {
          menu: controller.menu,
          onPick: (source, index) => { controller.pick(source, index) },
          onDismiss: () => { controller.dismiss() },
          t: scope.locale.bind(MENU_NS),
        }
      },
    }, MenuView), 'ui-slash: MenuView overlay registration')
  })
}
