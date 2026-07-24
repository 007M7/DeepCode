/**
 * Agent-scoped dispatch helpers. An agent-subject event travels with the
 * agent's scope carrier as `thisArg` (so scoped listeners filter to their own
 * agent) and the agent itself as the first argument. Composable seams are
 * plain `ctx.waterfall(carrier, name, agent, …, next)` calls at the machine's
 * call sites — concrete event names type-check against the real Cordis
 * overloads, so no generic wrapper (and none of its casts) is needed. The one
 * helper here is {@link emitAgentEvent}: a contained fire-and-forget emit.
 * @module @deepseek-ai/dsh-agent/dispatch
 */

import type { Context, Events } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from './types.ts'

/**
 * The event names whose subject is an agent: handler parameters start with an
 * `Agent` AND the handler declares a `Scoped<Agent>` `this` (the scope-carrier
 * contract). The `this` check keeps accidental first-parameter-happens-to-be-
 * an-Agent events (or zero-arg events, whose parameter tuple would satisfy a
 * bare rest-tuple check via callability) out of the fused-dispatch surface.
 */
export type AgentSubjectEvent = {
  [K in keyof Events]: Events[K] extends (this: Scoped<Agent>, ...args: infer P) => unknown
    ? P extends [Agent, ...unknown[]] ? K : never
    : never
}[keyof Events]

/** The event arguments AFTER the injected agent subject. */
type Tail<K extends AgentSubjectEvent> = Events[K] extends (...args: infer P) => unknown
  ? P extends [Agent, ...infer R] ? R : never
  : never

/**
 * The scope carrier for an agent-subject dispatch: the agent fused as both
 * the carrier key and the event subject, so the two cannot diverge. Pass it
 * as the `thisArg` of `ctx.serial` / `ctx.waterfall` for agent events.
 * @param agent - the subject agent.
 * @returns the fused carrier.
 */
export function agentCarrier(agent: Agent): Scoped<Agent> {
  return scopeTarget(agent, agent)
}

/**
 * Fire-and-forget notification in the agent's scope. Every listener is
 * invoked; synchronous throws and returned-promise rejections are logged and
 * contained per listener, so a notification cannot veto lifecycle progress or
 * starve a later observer. (Raw Cordis `emit` maps callbacks unguarded — one
 * synchronous throw would starve the rest and escape into the caller.)
 * @param ctx - the context to dispatch through (any context of the app).
 * @param agent - the subject agent; also the scope-carrier key.
 * @param name - the agent-subject event to emit.
 * @param rest - the event's arguments after the injected agent.
 */
export function emitAgentEvent<K extends AgentSubjectEvent>(ctx: Context, agent: Agent, name: K, ...rest: Tail<K>): void {
  const args: unknown[] = [agentCarrier(agent), name, agent, ...rest]
  for (const callback of ctx.events.dispatch('emit', args)) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`agent event "${name}" listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`agent event "${name}" listener threw: ${String(error)}`)
    }
  }
}

/**
 * Build the prompt assembly context with agent and scope set together, so
 * agent-scoped prompt and tool contributions cannot be silently omitted.
 * @param agent - the agent the assembly is for.
 * @param signal - the current turn's explicit control signal, when assembly belongs to a turn.
 * @returns the context to pass to `assemble()`.
 */
export function assembleContextFor(agent: Agent, signal?: AbortSignal): AssembleContext {
  return { agent, scope: agent, ...signal === undefined ? {} : { signal } }
}
