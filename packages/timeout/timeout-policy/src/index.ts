/**
 * `@deepseek-ai/dsh-timeout-policy`: the tool-call timeout policy plugin. It
 * registers ONE `tools/execute` around-dispatch listener that, for each
 * configured tool, arms a per-call deadline on `exec.signal` and returns a
 * structured `TOOL_TIMEOUT` result when that deadline wins.
 *
 * This is a COOPERATIVE deadline, not a hard kill: the derived signal only
 * NOTIFIES. A configured tool (and the capability it forwards `exec.signal` to)
 * must honor that signal and reach quiescence — the plugin never races the tool
 * promise or terminates work itself (see the timeout-library RFC's rejection of
 * `Promise.race`). "Configured" therefore MEANS "cooperative with `exec.signal`":
 * a tool that ignores the signal will not stop on timeout, so a deployment must
 * only list tools that forward it (the shipped web tools are the reference).
 *
 * Ownership of the `TOOL_TIMEOUT` code is entirely here: it is both the internal
 * {@link deadline} code (so {@link timeoutOf} scopes the classification to THIS
 * plugin's own timer, reading a foreign/nested outer deadline as an ordinary
 * cancel) and the structured `{ name, code }` on the replacement tool result.
 * No new session event is needed for reconstructability: the `TOOL_TIMEOUT`
 * result IS the final model-facing `tool/result`, already logged by the loop.
 *
 * Why a `tools/execute` around seam and not a `pre`/`post` pair: the deadline
 * needs ONE lexical scope — arm on `exec.signal`, delegate to dispatch, classify
 * the result, dispose the timer — which the around seam gives directly. A
 * pre/post split would spread one deadline's lifetime across two independent
 * waterfalls (a call-id map, cleanup on every deny/throw/dispose path).
 *
 * @module @deepseek-ai/dsh-timeout-policy
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { CallId } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * The code owned by this plugin, used BOTH as the internal {@link deadline}
 * classification code AND as the structured error `code` on the replacement
 * tool result. Scoping {@link timeoutOf} to it keeps a nested outer deadline
 * (another `tools/execute` wrapper's timer that fired first) from being misread
 * as this plugin's own timeout — it reads as an ordinary upstream cancel.
 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'timeout-policy'

/** Per-tool timeout policy. `timeoutMs` is required and must be positive finite. */
export interface ToolTimeoutPolicy {
  /** The per-call cooperative deadline for this tool, in milliseconds. */
  timeoutMs: number
}

/**
 * Plugin config: per-tool timeout policy, keyed by the model-facing tool name.
 * There is deliberately NO global default (a global budget would silently start
 * failing any tool that happens to run long once the plugin loads) and NO model
 * override (timeout is deployment policy, not prompt semantics) in this version.
 */
export interface Config {
  /** Timeout policy per tool name; an unlisted tool gets no deadline from this plugin. */
  tools?: Record<string, ToolTimeoutPolicy>
}

export const Config: z<Config> = z.object({
  tools: z.dict(z.object({ timeoutMs: z.number() })).default({}),
})

/** The shape after schemastery fills `tools` with its `{}` default. */
type ResolvedConfig = Required<Config>

/** A per-tool timeout must be a positive finite number (0 is not a "disable" value). */
function assertPositiveFinite(toolName: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`timeout-policy: tools.${toolName}.timeoutMs must be a positive finite number`)
  }
}

/**
 * The structured result substituted when this plugin's deadline wins. `content`
 * is the model-facing message; `error.code` is the same {@link TOOL_TIMEOUT}
 * this plugin owns, so a retry/sandbox plugin (and replay) can route on it.
 */
export function toolTimeoutResult(callId: CallId, timeoutMs: number): ToolExecutionResult {
  return {
    callId,
    content: [{ type: 'text', text: `Error: tool call timed out after ${timeoutMs}ms` }],
    isError: true,
    error: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT },
  }
}

/**
 * Register the tool-call timeout policy. For a configured tool the listener arms
 * a {@link deadline} on the caller's `exec.signal`, swaps it onto `exec` for the
 * downstream dispatch (cordis `next()` ignores passed arguments, so a wrapper
 * mutates the shared `exec` in place), restores the original signal afterward so
 * `tools/post-execute` sees the caller's own signal, and replaces the result
 * with {@link toolTimeoutResult} when its own timer fired. An unconfigured tool
 * delegates untouched.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled `tools` with its {} default.
  const resolved = config as ResolvedConfig
  for (const [toolName, policy] of Object.entries(resolved.tools)) {
    assertPositiveFinite(toolName, policy.timeoutMs)
  }

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = resolved.tools[exec.name]?.timeoutMs
    // Unconfigured tool: no deadline, delegate unchanged.
    if (timeoutMs === undefined) return next()

    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    // Swap the derived deadline onto exec for dispatch, then restore the
    // caller's own signal so post-execute listeners never see this plugin's
    // (possibly already-aborted) timeout signal. `undefined` is not assignable to
    // the optional `signal` under exactOptionalPropertyTypes, so branch on it.
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      // If OUR timer fired (scoped by code — a nested outer deadline reads as
      // undefined here), the tool/capability saw the abort and reached
      // quiescence; replace whatever it returned (its own abort result) with the
      // structured TOOL_TIMEOUT the model sees.
      if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
        return toolTimeoutResult(exec.callId, timeoutMs)
      }
      return result
    } finally {
      if (upstream === undefined) delete exec.signal
      else exec.signal = upstream
    }
  })
}
