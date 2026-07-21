/** Package-owned durable todo-snapshot invariants. @module @deepseek-ai/dsh-tool-todo/invariant */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-todo'
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/** Cordis companion plugin name. */
export const name = 'tool-todo-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one whole-list todo snapshot before it reaches the durable log. */
function validateTodos(value: unknown, fail: InvariantFailure): void {
  if (!Array.isArray(value)) fail('todo/write todos must be an array')
  const seen = new Set<string>()
  let active = 0
  for (const item of value) {
    if (typeof item !== 'object' || item === null) fail('todo/write entries must be objects')
    const { content, status } = item as Record<string, unknown>
    if (typeof content !== 'string' || content.length === 0 || content.trim() !== content) {
      fail('todo/write content must be non-empty and already trimmed')
    }
    if (seen.has(content)) fail(`todo/write repeats content ${JSON.stringify(content)}`)
    seen.add(content)
    if (typeof status !== 'string' || !TODO_STATUSES.has(status)) {
      fail(`todo/write carries unknown status ${JSON.stringify(status)}`)
    }
    if (status === 'in_progress') active += 1
  }
  if (active > 1) fail(`todo/write contains ${active} in-progress entries; at most one is allowed`)
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event shape and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'todo/write') validateTodos(event.data.todos, fail)
}

/** Install validation for loaded and newly appended whole-list todo snapshots. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the todo invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
