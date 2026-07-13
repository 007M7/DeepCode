/**
 * Fused scope-carrier dispatch for agent-subject operations, plus the assembly
 * context builder. The sanctioned ordinary spelling is
 * `agentEvents(ctx, agent).waterfall('agent/request', …)`: it builds the scope
 * carrier ({@link scopeTarget} keyed by the agent) AND injects the subject as
 * the first argument in one move, so a site cannot name a different subject.
 * The registry lifecycle pair is the deliberate exception: `enter()` captures
 * one stable carrier before commit and `announce()`/detach dispatch through it
 * directly, so both lifecycle edges use the same routing identity. The dev
 * scoped-dispatch invariant checks both shapes.
 *
 * @module @deepseek-ai/dsh-agent/dispatch
 */

import type { Context, Events } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from './types.ts'

/** Extract the parameter tuple from an event handler type (its `this` is not part of the tuple). */
type Params<F> = F extends (...args: infer P) => unknown ? P : never
/** Extract the return type from an event handler type. */
type Return<F> = F extends (...args: never[]) => infer R ? R : never

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
type Tail<K extends AgentSubjectEvent> = Params<Events[K]> extends [Agent, ...infer R] ? R : never

/**
 * The fused dispatcher {@link agentEvents} returns: each method dispatches the
 * named agent-subject event with the agent's scope carrier as `thisArg` and
 * the agent itself injected as the first event argument.
 */
export interface AgentEventDispatch {
  /**
   * Fire-and-forget notification in the agent's scope. Every listener is
   * invoked; synchronous throws and returned-promise rejections are logged and
   * contained per listener, so a notification cannot veto lifecycle progress
   * or starve a later observer.
   * @param name - the agent-subject event to emit.
   * @param rest - the event's arguments after the injected agent.
   */
  emit<K extends AgentSubjectEvent>(name: K, ...rest: Tail<K>): void
  /**
   * Awaited in-order dispatch (Cordis `serial`) in the agent's scope.
   * @param name - the agent-subject event to dispatch.
   * @param rest - the event's arguments after the injected agent.
   * @returns the serial chain's result (the first bail value, if any).
   */
  serial<K extends AgentSubjectEvent>(name: K, ...rest: Tail<K>): Promise<Awaited<Return<Events[K]>>>
  /**
   * Around-middleware dispatch (Cordis `waterfall`) in the agent's scope. The
   * declared event parameters already end with the `next` callback, so `rest`
   * is exactly the event's arguments after the injected agent — the final
   * element being the innermost `next` (the default the listener chain wraps).
   * @param name - the agent-subject event to dispatch.
   * @param rest - the event's arguments after the injected agent.
   * @returns the waterfall's composed result.
   */
  waterfall<K extends AgentSubjectEvent>(name: K, ...rest: Tail<K>): Return<Events[K]>
}

/**
 * Build the fused dispatcher for `agent`'s events (see the module doc). Cheap
 * (one carrier + one small object) — dispatch sites create it per run/turn
 * rather than caching it on the agent.
 * @param ctx - the context to dispatch through (any context of the app).
 * @param agent - the subject agent; also the scope-carrier key.
 * @returns the fused dispatcher.
 */
export function agentEvents(ctx: Context, agent: Agent): AgentEventDispatch {
  const carrier: Scoped<Agent> = scopeTarget(agent, agent)
  // The ordinary dispatch methods forward through Cordis' variadic mixins. The
  // fused (carrier, name, agent, ...rest) tuple is provably a valid argument
  // list for the matching thisArg overload, but TypeScript cannot relate the
  // generic Tail<K> spread back to that overload's conditional parameter
  // tuple — hence one contained, shape-preserving cast per method.
  return {
    emit(name, ...rest) {
      // Cordis emit invokes callbacks through Array.map: one synchronous throw
      // starves later listeners, and returned promises are discarded. Agent
      // notifications are non-vetoing, so resolve the same filtered callback
      // set ourselves and contain both failure modes independently.
      const args: unknown[] = [carrier, name, agent, ...rest]
      const callbacks = ctx.events.dispatch('emit', args)
      for (const callback of callbacks) {
        try {
          const returned: unknown = callback(...args)
          void Promise.resolve(returned).catch((error: unknown) => {
            ctx.logger.warn(`agent event "${name}" listener rejected: ${String(error)}`)
          })
        } catch (error: unknown) {
          ctx.logger.warn(`agent event "${name}" listener threw: ${String(error)}`)
        }
      }
    },
    async serial(name, ...rest) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the events mixin accessor returns a pre-bound function
      const serial = ctx.serial as (thisArg: Scoped<Agent>, name: string, ...args: unknown[]) => Promise<never>
      return await serial(carrier, name, agent, ...rest)
    },
    waterfall(name, ...rest) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the events mixin accessor returns a pre-bound function
      const waterfall = ctx.waterfall as (thisArg: Scoped<Agent>, name: string, ...args: unknown[]) => never
      return waterfall(carrier, name, agent, ...rest)
    },
  }
}

/**
 * The assembly context for one agent's prompt: the typed `agent` DX field and
 * the `scope` layer selector, set together (setting `agent` without `scope`
 * silently drops the agent's scoped sections/tools from the assembly — the
 * dev invariants flag it). THE way the loop (and any custom driver) builds
 * its per-step `ctx.systemPrompt.assemble(…)` input.
 * @param agent - the agent the assembly is for.
 * @returns the context to pass to `assemble()`.
 */
export function assembleContextFor(agent: Agent): AssembleContext {
  return { agent, scope: agent }
}
