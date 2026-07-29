/**
 * Human-facing `/feedback` command. It records a remark about the session and
 * does nothing else: the command registry's own `command/run` and
 * `command/done` events are the whole record, so this plugin only validates the
 * input and acknowledges it. Those appends are eager but unflushed, so the
 * acknowledgement reports the entry is logged, not that it reached disk.
 * @module @deepseek-ai/dsh-command-feedback
 */

import type { Context } from 'cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-feedback'
export const inject = ['commands']

const USAGE = 'Usage: /feedback <text>'

/**
 * Validate and acknowledge one feedback entry. `command/run` already carries
 * the verbatim text, so no further append is needed; returning an error instead
 * settles that record as `kind: 'error'` and leaves no accepted feedback.
 * @param invocation - receiving agent, raw command input, and UI cancellation.
 * @returns an acknowledgement, or a usage error when no feedback text was supplied.
 */
function executeFeedbackCommand(invocation: CommandInvocation): CommandResult {
  if (invocation.rawInput.trim().length === 0) {
    return { kind: 'error', text: `Feedback text is required. ${USAGE}` }
  }
  return { kind: 'success', text: 'Feedback recorded.' }
}

/** Register the global `/feedback` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'feedback',
    description: 'record feedback about this session',
    input: { hint: '<text>' },
    handler: executeFeedbackCommand,
  })
}
