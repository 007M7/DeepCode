/**
 * Parse a finished hook command's process outcome (exit code + stdout + stderr)
 * into the dialect-neutral {@link HookOutput} both bridges map from.
 *
 * The exit-code contract is shared by Claude Code and Codex:
 * - exit 0  → success; if stdout is structured JSON, parse it; else the plain
 *   stdout is available to the bridge (some events treat it as `additionalContext`).
 * - exit 2  → BLOCKING error; stderr is the block reason fed back to the model.
 *   We surface this as `decision: 'block'` with `reason = stderr` so a bridge
 *   needs no separate exit-code branch — the neutral output already says "block".
 * - other   → non-blocking error; recorded (exitCode + stderr) but no decision.
 *
 * Structured-stdout fields are a SUPERSET across dialects (CC is richest); we
 * parse every field we recognize and leave it to the bridge to honor only the
 * subset meaningful for its dialect/hook point (Codex, e.g., ignores
 * `allow`/`ask`/`updatedInput`).
 *
 * @module @deepseek-ai/dsh-hook-protocol/codec
 */

import type { HookOutput } from './types.ts'

/** The exit code a hook uses to signal a blocking error (stderr → model). */
const BLOCKING_EXIT_CODE = 2

/** Read a string field from a parsed object, or `undefined` if absent/wrong type. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/** Read a boolean field, or `undefined` if absent/wrong type. */
function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key]
  return typeof v === 'boolean' ? v : undefined
}

/** A plain (non-null, non-array) object, or `undefined`. */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The legacy TOP-LEVEL `decision` is only `approve`/`block` in both reference
 * schemas — `allow`/`deny`/`ask` are reserved for `hookSpecificOutput.
 * permissionDecision`. So an out-of-band `{"decision":"deny"}` is invalid and
 * ignored here (it must not become a real blocking decision).
 */
function topLevelDecisionOf(value: string | undefined): HookOutput['decision'] {
  return value === 'approve' || value === 'block' ? value : undefined
}

/** A `hookSpecificOutput.permissionDecision` is `allow`/`deny`/`ask` only. */
function permissionDecisionOf(value: string | undefined): HookOutput['decision'] {
  return value === 'allow' || value === 'deny' || value === 'ask' ? value : undefined
}

/**
 * Parse one finished hook command into a {@link HookOutput}. `stdout`/`stderr`
 * are the captured streams; `exitCode` is the process exit (`undefined` when the
 * hook could not be spawned at all). Pure and total — never throws; malformed
 * JSON on a 0 exit is treated as "no structured output" (the plain stdout is
 * still on the bridge to use), matching both reference engines' lenient parse of
 * non-JSON stdout.
 *
 * `expectedEventName` is the event the hook is FIRING for (e.g. `'PreToolUse'`).
 * The reference schemas key the `hookSpecificOutput` block by `hookEventName`,
 * so a block whose `hookEventName` names a DIFFERENT event is malformed and its
 * event-scoped fields (`permissionDecision`/`permissionDecisionReason`/
 * `additionalContext`/`updatedInput`) are DISCARDED — a `PreToolUse` block on a
 * `Stop` hook must not deny the `Stop`. The block's `hookEventName` is still
 * surfaced (for the log/diagnostics), and the event-agnostic top-level fields
 * (`decision`/`reason`/`continue`/`stopReason`/`systemMessage`)
 * are unaffected. Omit `expectedEventName` (or pass a matching one) to apply the
 * block as-is — a caller that doesn't key by event opts out of the check.
 */
export function parseHookOutput(exitCode: number | undefined, stdout: string, stderr: string, expectedEventName?: string): HookOutput {
  const trimmedErr = stderr.trim()
  const trimmedOut = stdout.trim()
  // Keep the raw stdout verbatim: a clean-exit hook may emit PLAIN text the
  // protocol renders/uses (CC output; Codex SessionStart/UserPromptSubmit
  // additionalContext), so the bridge needs it even when there's no JSON.
  const output: HookOutput = { exitCode, stderr: trimmedErr, stdout: trimmedOut }

  // Exit 2 is a blocking error in both dialects: stderr is the reason. Surface
  // it as a `block` decision so the bridge maps it uniformly with a structured
  // `decision:'block'` — the exit code and the JSON channel converge here.
  if (exitCode === BLOCKING_EXIT_CODE) {
    output.decision = 'block'
    if (trimmedErr.length > 0) output.reason = trimmedErr
  }

  // Structured stdout is only consulted on a clean (0) exit; on a blocking exit
  // the stderr channel is authoritative. A non-zero/undefined exit other than 2
  // carries no decision (the bridge records it as a non-blocking error).
  if (exitCode === 0) {
    // Only attempt JSON when stdout looks like a JSON object — matches the
    // reference engines, which treat other stdout as plain text, not an error.
    if (trimmedOut.startsWith('{')) {
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = obj(JSON.parse(trimmedOut))
      } catch {
        // Malformed JSON on a clean exit = no structured output (lenient, as the
        // reference engines are). The plain stdout remains the bridge's to use.
        parsed = undefined
      }
      if (parsed) applyStructured(output, parsed, expectedEventName)
    }
  }

  return output
}

/**
 * Fold a parsed structured-stdout object into `output` (mutates in place).
 * `expectedEventName` (the firing event) gates the per-event `hookSpecificOutput`
 * block: a block whose `hookEventName` names a different event — OR omits it — has
 * its event-scoped fields discarded (any present `hookEventName` is still recorded).
 */
function applyStructured(output: HookOutput, parsed: Record<string, unknown>, expectedEventName?: string): void {
  const cont = bool(parsed, 'continue')
  if (cont !== undefined) output.continue = cont
  const stopReason = str(parsed, 'stopReason')
  if (stopReason !== undefined) output.stopReason = stopReason
  const sysMsg = str(parsed, 'systemMessage')
  if (sysMsg !== undefined) output.systemMessage = sysMsg

  // Top-level legacy `decision` (approve/block ONLY — allow/deny/ask there are
  // invalid per both schemas) + its `reason`.
  const topDecision = topLevelDecisionOf(str(parsed, 'decision'))
  if (topDecision !== undefined) output.decision = topDecision
  const topReason = str(parsed, 'reason')
  if (topReason !== undefined) output.reason = topReason

  // hookSpecificOutput: the per-event channel, keyed by `hookEventName`. The
  // permissionDecision (allow/deny/ask) OVERRIDES the legacy top-level decision;
  // additionalContext and updatedInput live here too.
  const hso = obj(parsed.hookSpecificOutput)
  if (hso) {
    const eventName = str(hso, 'hookEventName')
    // Always surface the discriminator (for the log/diagnostics), even on a
    // mismatch — the record should show what the malformed block claimed.
    if (eventName !== undefined) output.hookEventName = eventName
    // The schemas key this block by event: when a caller passes the firing event
    // (`expectedEventName`), the block's `hookEventName` MUST name it. A different
    // name — or a MISSING one — is malformed under the keyed schema, so discard the
    // event-scoped fields (a PreToolUse block must not deny a Stop hook; nor may a
    // discriminator-less block silently apply PreToolUse-scoped permission fields to
    // whatever event is firing). A caller that passes no expectedEventName opts out
    // of the check (applies the block as-is).
    if (expectedEventName !== undefined && eventName !== expectedEventName) {
      return
    }
    const permission = permissionDecisionOf(str(hso, 'permissionDecision'))
    if (permission !== undefined) output.decision = permission
    const permissionReason = str(hso, 'permissionDecisionReason')
    if (permissionReason !== undefined) output.reason = permissionReason
    const addCtx = str(hso, 'additionalContext')
    if (addCtx !== undefined) output.additionalContext = addCtx
    const updated = obj(hso.updatedInput)
    if (updated !== undefined) output.updatedInput = updated
  }
}
