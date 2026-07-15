/**
 * Model-facing result rendering for the bash tool.
 *
 * @module @deepseek-ai/dsh-tool-bash/render
 */

import type { BashProcessRead, BashRunResult, BashSandboxInfo, CollectedOutput } from '@deepseek-ai/dsh-bash'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are reported, not
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
  // Keep the exit marker last because parseExitStatus anchors there.
  if (result.sandbox?.denied) {
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
    // Hint only when the composition exposes escalation, before the final exit marker.
    if (escalationModes.length > 0) {
      markers.push('[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
    }
  }
  // A command may trap SIGTERM and exit 0 after timeout; still report interruption.
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

/**
 * Shape one background-process read into the `task_output` delta the model
 * sees: the incremental delta, plus the lossy-read notice (with full-stream
 * spill paths) when in-memory truncation dropped unread bytes. Empty-delta
 * rendering (`(no new output)`) is the generic control surface's job.
 * @param read - one incremental read from the process handle.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the delta text with any loss or sandbox notice appended.
 */
export function renderProcessRead(
  read: BashProcessRead,
  sandbox?: BashSandboxInfo,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const notices: string[] = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path): path is string => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(`[sandbox: file access denied under ${sandbox.mode} mode]`)
    if (escalationModes.length > 0) {
      notices.push('[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
    }
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

/**
 * Recover the structured exit status from a rendered {@link renderResult}
 * string — the inverse of the status markers it appends. A killed marker
 * yields `signal`; otherwise a non-zero marker yields `exitCode`; absent both
 * means a clean exit 0.
 *
 * Replay only retains the rendered content text, not the original
 * `BashRunResult`, so terminal presentation must recover the exit pill here.
 * Requiring a leading newline and the end of the string keeps ordinary output
 * that merely ends with marker-like text from matching unless the final line
 * is indistinguishable from a real marker.
 * @param text - rendered model-facing bash result.
 * @returns the recovered terminal exit code or signal.
 */
export function parseExitStatus(text: string): { exitCode: number } | { signal: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { exitCode: Number(exit[1]) }
  return { exitCode: 0 }
}
