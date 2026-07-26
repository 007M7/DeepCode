/**
 * Subagent reference plugin, browser half: registers the '@' source —
 * candidates filtered from the session list snapshot's running children
 * (zero RPC; the list rides the plugin's root-context sessions service, the
 * scoped session comes from the per-call projection), pick inserts the
 * literal `@label ` text (decision 21: the draft carries plain text, chip
 * visuals are derived by scanning against the source lexicon, and the
 * prompt ships the same literal). Consumption semantics stay with future
 * business work (design ledger). No adjudication hooks: subagent
 * references never enter command adjudication.
 */
import type { ClientContext, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientSessionContext, SlashServiceContract, SlashSource } from '@deepseek-ai/dsh-client-ui-slash/client'

/** Required services: the slash registry + the session list face the source closes over. */
export const inject = ['slash', 'sessions']

/**
 * Client plugin body: register the '@' subagent source over the root session list.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as SessionsService
  // Child labels live on the session list (parentId lineage + displayTitle),
  // not the conversation snapshot — the list store is the zero-RPC candidate feed.
  const childLabels = (session: ClientSessionContext, query: string): string[] => {
    const { byId } = sessions.list.getSnapshot()
    return Object.values(byId)
      .filter(child => child.parentId === session.sessionId && child.running && child.displayTitle.includes(query))
      .map(child => child.displayTitle)
  }
  const source: SlashSource = {
    trigger: '@',
    name: 'subagent',
    candidates(session, { query }) {
      return Promise.resolve(childLabels(session, query).map(name => ({ name })))
    },
    lexicon(session) {
      // The list snapshot is always warm — the full running-children roster.
      return childLabels(session, '')
    },
    onPick({ candidate }) {
      // Decision 21: plain-text reference — the literal lands in the draft
      // and ships to the model verbatim (trailing space closes the token).
      // Legacy path (decision 21), retained for the removal cut, no longer reached:
      // return { insert: { source: 'subagent', ref: candidate.name, label: candidate.name, clipboardText: `@${candidate.name}` } }
      return { text: `@${candidate.name} ` }
    },
    codec: {
      clipboardText: ref => `@${ref}`,
      // TODO: serialize returns the raw label until the '@' consumption
      // feature defines a model representation (design ledger).
      serialize: ref => Promise.resolve(`@${ref}`),
    },
  }
  const slash = ctx.get('slash') as SlashServiceContract
  ctx.effect(() => slash.registerSource(source), 'ui-subagent: @ source')
}
