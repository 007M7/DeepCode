/**
 * A scripted {@link SubagentProvider} for testing the subagent seam WITHOUT a
 * model or a real child agent. Mirrors `@deepseek-ai/dsh-llm-replay`: it lets a
 * test drive the service and the model-facing tool through the REAL cordis
 * Loader / export path, exercising registration, capability validation, the
 * run lifecycle, and the structured-output branch deterministically.
 *
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default —
 * a functional plugin (it only registers a provider; it is never injected).
 *
 * @module @deepseek-ai/dsh-subagent-mock
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

const STOP_REASONS = ['completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const

const DEFAULT_CAPS: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true }

/**
 * A scripted provider: every {@link start} returns a run whose `result`
 * resolves on a microtask with the configured reply (and a structured value
 * when the request asked for one and the capability is on). `dispose` is a
 * no-op; a `cancel()` before the result settles flips the stop reason to
 * `aborted`, so the cancellation path is observable in a test.
 */
class MockSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities

  constructor(
    readonly name: string,
    private readonly config: Config,
  ) {
    this.capabilities = { ...DEFAULT_CAPS, ...config.capabilities }
  }

  start(request: SubagentStartRequest): SubagentRun {
    const reply = this.config.reply ?? 'mock subagent reply'
    const output: ContentBlock[] = [{ type: 'text', text: reply }]
    const wantsStructured = request.outputSchema !== undefined && this.capabilities.outputSchema
    const baseStop: SubagentStopReason = this.config.stopReason ?? 'completed'
    let cancelled = false

    // A deterministic child id derived from the parent — no clock/random (both
    // banned in deterministic paths here, and unnecessary for a scripted run).
    const id = AgentId(`mock-subagent:${this.name}:${request.parent.id}`)

    const resultFor = (): SubagentResult => ({
      output,
      structured: wantsStructured ? (this.config.structured ?? { reply }) : undefined,
      stopReason: cancelled ? 'aborted' : baseStop,
    })

    return {
      id,
      result: Promise.resolve().then(resultFor),
      cancel() {
        cancelled = true
      },
      async dispose() {
        // Scripted run holds no resources — nothing to await.
      },
    }
  }
}

export const name = 'subagent-mock'
export const inject = ['subagents']

/** Config for the mock provider; all optional with test-friendly defaults. */
export interface Config {
  /** Registry name to register under. */
  name: string
  /** The text the scripted child "returns" as its final answer. */
  reply?: string
  /** The stop reason the run settles with. */
  stopReason?: SubagentStopReason
  /** Which start-time capabilities to advertise (default: all `true`). */
  capabilities?: Partial<SubagentCapabilities>
  /**
   * Structured value surfaced when a request carries an `outputSchema` and the
   * `outputSchema` capability is on (default: `{ reply }`).
   */
  structured?: unknown
}

export const Config: z<Config> = z.object({
  name: z.string().default('mock'),
  reply: z.string(),
  stopReason: z.union(STOP_REASONS),
  capabilities: z.object({
    outputSchema: z.boolean(),
    depthLimit: z.boolean(),
    toolFilter: z.boolean(),
  }),
  structured: z.any(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new MockSubagentProvider(config.name, config))
}
