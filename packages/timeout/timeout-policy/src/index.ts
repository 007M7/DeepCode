/**
 * `@deepseek-ai/dsh-timeout-policy`: the tool-call timeout ENFORCER. It registers
 * ONE `tools/execute` around-dispatch listener that, for a tool declaring a
 * `timeoutMs` on its {@link ToolDefinition}, arms a per-call deadline on
 * `exec.signal` and returns a structured `TOOL_TIMEOUT` result when that deadline
 * wins. The budget is DECLARED by the tool (see `ToolDefinition.timeoutMs`, set
 * by the owning tool plugin from its own config); this plugin only enforces it,
 * so it is zero-config and there is no tool-name map to mistype.
 *
 * This is a COOPERATIVE deadline, not a hard kill: the derived signal only
 * NOTIFIES. A tool that declares `timeoutMs` (and the capability it forwards
 * `exec.signal` to) must honor that signal and reach quiescence — the plugin
 * never races the tool promise or terminates work itself (see the timeout-library
 * RFC's rejection of `Promise.race`). Declaring `timeoutMs` therefore MEANS "this
 * tool is cooperative with `exec.signal`": a tool that ignores the signal will
 * not stop on timeout, so only signal-forwarding tools should declare it (the
 * shipped web tools are the reference).
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

/** The tool registry seam this plugin wraps (`tools/execute`) and reads (`get`). */
export const inject = ['tools']

/**
 * The structured result substituted when this plugin's deadline wins. `content`
 * is the model-facing message; `error.code` is the same {@link TOOL_TIMEOUT}
 * this plugin owns, so a retry/sandbox plugin (and replay) can route on it.
 *
 * @param callId - the timed-out call's id, carried onto the replacement result.
 * @param timeoutMs - the elapsed budget, rendered into the model-facing message.
 * @returns the `isError` {@link ToolExecutionResult} with a `TOOL_TIMEOUT` error.
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
 * Register the tool-call timeout enforcer. For a tool whose {@link ToolDefinition}
 * declares `timeoutMs`, the listener arms a {@link deadline} on the caller's
 * `exec.signal`, swaps it onto `exec` for the downstream dispatch (cordis
 * `next()` ignores passed arguments, so a wrapper mutates the shared `exec` in
 * place), restores the original signal afterward so `tools/post-execute` sees the
 * caller's own signal, and replaces the result with {@link toolTimeoutResult}
 * when its own timer fired. A tool that declares no budget delegates untouched.
 *
 * The budget source is the tool's own declaration read from the registry
 * (`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`), NOT a plugin config map —
 * `exec.name` is the tool being dispatched, so the lookup always resolves and
 * there is no mistypable tool name and no unknown-name path to warn or throw
 * about. Resolution goes through the CALLER's visible view (the `exec.agent`
 * scope), exactly like dispatch itself: a scoped tool's own `timeoutMs` governs
 * its calls, and a global name-twin's budget is never misapplied to a shadowing
 * per-agent variant.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
    // A tool that declares no budget: no deadline, delegate unchanged.
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
