/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-source-guard`.
 * @module @deepseek-ai/dsh-source-guard/invariant
 */

import type { Context } from 'cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-source-guard'

/** Cordis companion plugin name. */
export const name = 'source-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The durable shape of this guard's refusal. The denial is the package's only
 * model-visible output, and it is actionable only when it names all three of
 * the offending path, the branch that protects it, and the skill that lifts
 * the denial — a refusal missing any of them tells the model to stop without
 * telling it how to proceed.
 */
const DENIAL = new RegExp(
  '^Error: Editing "(?<path>.+)" directly is not allowed: '
  + 'it is inside the dsh checkout this session is running from, on branch (?<branch>\\S+)\\. '
  + 'Load the (?<skill>\\S+) skill first and follow it '
  + '— implement in a task worktree, then integrate under the staging lock\\.$',
)

/** The denial prefix identifying a result this package produced, before its full shape is validated. */
const DENIAL_PREFIX = 'Error: Editing "'

/** Validate one guard-produced denial result's model-facing text. */
function validateDenial(text: string, fail: InvariantFailure): void {
  const match = DENIAL.exec(text)
  if (match === null) {
    fail('source-guard denial must name the path, the protecting branch, and the skill that lifts it')
  }
  // The pattern's `\S+` groups already establish a non-empty branch and skill;
  // only path absoluteness remains to check.
  const { path } = match.groups as { path: string }
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    fail(`source-guard denial must name an absolute path, got ${JSON.stringify(path)}`)
  }
}

/** Validate every guard denial carried by one session's durable log. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) {
    if (event.type !== 'tool/result') continue
    validateEvent(event, fail)
  }
}

/** Validate one durable tool result, when it carries this package's denial. */
function validateEvent(event: SessionEvent<'tool/result'>, fail: InvariantFailure): void {
  const result = event.data.message.content[0]
  if (result.isError !== true) return
  for (const block of result.content) {
    if (block.type !== 'text' || !block.text.startsWith(DENIAL_PREFIX)) continue
    validateDenial(block.text, fail)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended denial results. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type !== 'tool/result') return
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
