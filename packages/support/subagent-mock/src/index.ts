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

const DEFAULT_CAPS: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

/**
 * A scripted provider: every {@link start} returns a ready run whose `result`
 * resolves on the next task with the configured reply (and a structured value
 * when the request asked for one and the capability is on). The required
 * signal and `dispose()` both flip an unsettled result to `aborted`.
 */
class MockSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean

  constructor(
    readonly name: string,
    private readonly config: Config,
  ) {
    this.capabilities = { ...DEFAULT_CAPS, ...config.capabilities }
    this.inheritsParentContext = config.inheritsParentContext ?? false
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) throw new Error('mock subagent start aborted before publication')
    const reply = this.config.reply ?? 'mock subagent reply'
    const output: ContentBlock[] = [{ type: 'text', text: reply }]
    const wantsStructured = request.outputSchema !== undefined && this.capabilities.outputSchema
    const baseStop: SubagentStopReason = this.config.stopReason ?? 'completed'
    const flags = { cancelled: false }
    const onAbort = (): void => { flags.cancelled = true }
    request.signal.addEventListener('abort', onAbort, { once: true })
    // Make publication genuinely asynchronous so a same-turn abort is still
    // a provider-owned startup failure rather than a returned live run.
    await Promise.resolve()
    if (flags.cancelled) {
      request.signal.removeEventListener('abort', onAbort)
      throw new Error('mock subagent start aborted before publication')
    }

    // A deterministic child id derived from the parent — no clock/random (both
    // banned in deterministic paths here, and unnecessary for a scripted run).
    const id = AgentId(`mock-subagent:${this.name}:${request.parent.id}`)

    const resultFor = (): SubagentResult => ({
      output,
      ...wantsStructured ? { structured: this.config.structured ?? { reply } } : {},
      stopReason: flags.cancelled ? 'aborted' : baseStop,
    })

    const result = new Promise<SubagentResult>((resolve) => {
      setTimeout(() => { resolve(resultFor()) }, 0)
    }).finally(() => {
      request.signal.removeEventListener('abort', onAbort)
    })
    return {
      id,
      result,
      dispose(): Promise<void> {
        flags.cancelled = true
        request.signal.removeEventListener('abort', onAbort)
        return Promise.resolve()
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
   * The conversation-history descriptor to declare
   * ({@link SubagentProvider.inheritsParentContext}); default `false` (fresh
   * conversation). Set `true` to exercise seeded/fork wording in consumer
   * tests. This flag says nothing about tool, service, scope, or authority
   * inheritance.
   */
  inheritsParentContext?: boolean
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
    persona: z.boolean(),
  }),
  inheritsParentContext: z.boolean(),
  structured: z.any(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new MockSubagentProvider(config.name, config))
}
