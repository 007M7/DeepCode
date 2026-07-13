/**
 * Model-facing result rendering for the bash tool.
 *
 * @module @deepseek-ai/dsh-tool-bash/render
 */

import type { BashRunResult, CollectedOutput } from '@deepseek-ai/dsh-bash'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are REPORTED, not
 * errored — the model decides how to react; only infrastructure failures
 * (spawn errors, aborts) surface as isError results.
 * @param result - the completed foreground run from the executor.
 * @param escalationModes - the escalation targets this composition advertises;
 *   non-empty adds the same-turn escalation hint after a denial marker
 *   (default `[]`: no hint).
 * @returns the model-facing text: output body (or `(no output)`), then any timeout/signal/exit markers, each on its own line.
 */
export function renderResult(
  result: BashRunResult,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    // Single newline between sections (stdout usually ends with one already).
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers: string[] = []
  // The sandbox marker precedes the exit-status markers so `[exit code: N]`
  // stays the LAST line (exitStatus() anchors its parse there). Denial is a
  // reported fact like timeout: the model decides how to react.
  if (result.sandbox?.denied) {
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
    // The same-turn nudge lives at the decision point: only when this
    // composition advertises the fields (a lever is never hinted that the
    // schema does not offer), and inside the sandbox marker family so the
    // exit-code marker stays the last line.
    if (escalationModes.length > 0) {
      markers.push('[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
    }
  }
  // Timeout is reported independently of how the process actually ended: a
  // command can trap SIGTERM and exit 0 after our timer fired (e.g.
  // `trap "exit 0" TERM; sleep 60`), giving timedOut:true / exitCode:0 /
  // signal:null — the model must still see that the command was cut short.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}
