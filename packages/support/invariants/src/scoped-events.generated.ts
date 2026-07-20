/**
 * Generated scoped-event routing-subject resolvers for dsh-invariants.
 * Do not edit by hand; run `pnpm run gen-scoped-events`.
 *
 * @module @deepseek-ai/dsh-invariants/scoped-events.generated
 */

import type { Events } from 'cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

type ScopedEventName = {
  [K in keyof Events]: ThisParameterType<Events[K]> extends Scoped<object> ? K : never
}[keyof Events]

type ScopedSubjectResolver = (args: readonly unknown[]) => unknown

function adapt<K extends ScopedEventName>(
  resolver: (args: Parameters<Events[K]>) => unknown,
): ScopedSubjectResolver {
  return args => resolver(args as Parameters<Events[K]>)
}

const scopedSubjectResolvers = Object.freeze({
  'agent/created': adapt<'agent/created'>(args => args[0]),
  'agent/disposed': adapt<'agent/disposed'>(args => args[0]),
  'agent/error': adapt<'agent/error'>(args => args[0]),
  'agent/post-step': adapt<'agent/post-step'>(args => args[0]),
  'agent/pre-step': adapt<'agent/pre-step'>(args => args[0]),
  'agent/prompt-submit': adapt<'agent/prompt-submit'>(args => args[0]),
  'agent/queued': adapt<'agent/queued'>(args => args[0]),
  'agent/request': adapt<'agent/request'>(args => args[0]),
  'agent/request-error': adapt<'agent/request-error'>(args => args[0]),
  'agent/session-prefix': adapt<'agent/session-prefix'>(args => args[0]),
  'agent/session-start': adapt<'agent/session-start'>(args => args[0]),
  'agent/status': adapt<'agent/status'>(args => args[0]),
  'agent/step-result': adapt<'agent/step-result'>(args => args[0]),
  'agent/turn-continuation': adapt<'agent/turn-continuation'>(args => args[0]),
  'agent/turn-stop': adapt<'agent/turn-stop'>(args => args[0]),
  'approval/request': adapt<'approval/request'>(args => args[0].agent),
  'goal/changed': adapt<'goal/changed'>(args => args[0]),
  'session/created': null,
  'session/disposed': null,
  'session/event': null,
  'session/flush': null,
  'subagent/end': null,
  'subagent/start': null,
  'system-prompt/assemble': adapt<'system-prompt/assemble'>(args => args[1].scope),
  'tools/execute': adapt<'tools/execute'>(args => args[0].agent),
  'tools/post-execute': adapt<'tools/post-execute'>(args => args[0].agent),
  'tools/pre-execute': adapt<'tools/pre-execute'>(args => args[0].agent),
  'tools/result': adapt<'tools/result'>(args => args[0].agent),
} as const satisfies Readonly<Record<ScopedEventName, ScopedSubjectResolver | null>>)

const scopedSubjectResolverIndex: Readonly<Record<string, ScopedSubjectResolver | null>> = scopedSubjectResolvers

/**
 * Resolve the routing key named by one scoped event payload. A null
 * resolver means the payload cannot expose its external routing key, so the
 * invariant checks carrier presence only.
 * @param event - runtime Cordis event name.
 * @returns the generated subject resolver, null for presence-only,
 *   or undefined when the event is not scope-filtered.
 */
export function scopedSubjectResolverFor(event: string): ScopedSubjectResolver | null | undefined {
  return scopedSubjectResolverIndex[event]
}
