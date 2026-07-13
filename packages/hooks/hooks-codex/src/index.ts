/**
 * `dsh-hooks-codex` — a bridge plugin that runs a user's existing Codex
 * `hooks.json` on the harness's canonical interception seams. The CODEX DIALECT
 * half of the hooks subsystem.
 *
 * Codex's hook protocol is a deliberate SUBSET of Claude Code's: five hook points
 * (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop` — no
 * subagent/notification/compaction), regex-only matchers, snake_case stdin
 * payloads with `turn_id`/`model` extras and NO trailing newline, no env vars and
 * no command substitution, and a block-only decision model (allow/ask are not
 * honored — a hook can only block, never pre-approve). The dialect-agnostic
 * primitives come from `@deepseek-ai/dsh-hook-protocol`; this bridge owns the
 * Codex-specific payloads + matcher mode + decision mapping.
 *
 * @module @deepseek-ai/dsh-hooks-codex
 */

import { readFileSync } from 'node:fs'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent, ContinuationDecision, HookContext, PromptDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
import { parseCodexConfig, type CodexHookConfig } from './config.ts'

export const name = 'hooks-codex'
export const inject = ['bash']

/** Plugin config: where the Codex hooks.json lives + the model name for payloads. */
export interface Config {
  /**
   * Path to a Codex `hooks.json`. PROCESS-LEVEL: read once at load, a relative
   * path resolves against the process launch cwd.
   * TODO(per-session-hook-config): per-session project-local discovery from each
   * `session/new.cwd` is not yet implemented.
   */
  configPath: string
  /** The model name stamped on every payload (Codex includes `model` on each event). */
  model?: string
  /** Default per-hook timeout in ms when a hook sets none (Codex default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  model: z.string().default(''),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
})

let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `codex:${point}:${++handlerCounter}`
}

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'hooks-codex' }

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-codex: ${name} must be a positive integer`)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Validate the cap BEFORE the config-file parse: a bad value must fail the
  // load loudly, not be skipped by the parse-failure early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  let parsed: CodexHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(config.configPath, 'utf8'))
    const result = parseCodexConfig(raw)
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`hooks-codex: skipping ${s.reason} on ${s.event} (only sync command hooks run)`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`hooks-codex: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`)
    return
  }

  const model = config.model ?? ''

  // SessionStart is the one emit-shaped (detached) point Codex has: track its
  // run chains so disposal aborts a still-running hook process and drains the
  // continuation (docs/defensive-patterns.md: dispose must reach quiescence).
  const detached = createDetachedRuns()
  ctx.effect(() => () => detached.drain(), 'hooks-codex: drain detached hook runs')

  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; signal?: AbortSignal; plainStdoutAsContext?: boolean },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = parsed[point] ?? []
    const outputs: HookOutput[] = []
    // Run the hook in the agent's session workspace (the `session/new` cwd), not
    // the executor default (the server launch dir) — a hook reading a relative
    // file or `pwd` must see the user's project tree. Absent for a no-agent run.
    const workdir = opts.agent?.session.header.cwd
    for (const group of groups) {
      // Codex matches with PURE regex (no literal fast path).
      if (!matchesMatcher(group.matcher, matchQuery, 'codex')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'codex', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.bash, hook, {
          payload,
          defaultTimeoutMs,
          ...workdir !== undefined ? { cwd: workdir } : {},
          ...opts.signal ? { signal: opts.signal } : {},
          trailingNewline: false, // Codex writes stdin WITHOUT a trailing newline.
          // Discard a `hookSpecificOutput` block naming a different event.
          expectedEventName: point,
        }, () => performance.now())
        // Codex's SessionStart/UserPromptSubmit treat a CLEAN hook's PLAIN
        // (non-JSON) stdout as additionalContext. The codec keeps that raw text on
        // `output.stdout` but only sets `additionalContext` from a JSON
        // `hookSpecificOutput`, so fold plain stdout in here and let the shared
        // merge + contextFrom path carry it. Gated exactly like the codec's own
        // structured-stdout parse: only on a clean `exitCode === 0` (a non-zero
        // exit is an error, not context — an `echo x; exit 2` must not inject
        // `x`), only when stdout is non-JSON (`!startsWith('{')` — a structured
        // hook's raw JSON is never dumped as prose), and never clobbering an
        // explicit additionalContext from a JSON block.
        if (opts.plainStdoutAsContext === true && output.exitCode === 0
          && output.additionalContext === undefined
          && output.stdout.length > 0 && !output.stdout.startsWith('{')) {
          output.additionalContext = output.stdout
        }
        outputs.push(output)
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-codex: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  // TODO(hook-continue-false): the merge computes `merged.stop`/`stopReason` from
  // a hook's `continue:false`, but no seam below honors it — there is no
  // "hard-halt the whole agent" primitive on the interception seams yet. Deferred
  // with the loop-guard work; until then a `continue:false` hook keeps its
  // per-point effect and the halt request is recorded in `hook/result`, not acted on.

  function contextFrom(merged: MergedHookOutcome): HookContext | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return { content, source: PLUGIN_SOURCE }
  }

  /**
   * Concatenate this bridge's {@link HookContext} (`ours`, always present at the
   * call sites) with a downstream listener's optional one, so folding our
   * additionalContext onto a delegated decision drops neither. The merged block
   * carries a single `source` — this bridge's — because a `HookContext` holds one
   * `MessageSource` and the seam cannot represent mixed provenance; the rendered
   * `context/message` only distinguishes by `source.kind` ('plugin'), so a
   * downstream plugin's text is still correctly framed as plugin context.
   */
  function concatContext(ours: HookContext, theirs: HookContext | undefined): HookContext {
    if (!theirs) return ours
    return { content: [...ours.content, ...theirs.content], source: ours.source }
  }

  // SessionStart: emit. Codex passes a plain-stdout hook's output as additionalContext.
  // TODO(session-start-gating): a synchronous emit + detached `.then`, so the
  // injected context is BEST-EFFORT — not guaranteed before the first turn reaches
  // the model (a slow hook can miss the first request). Gating is a deferred
  // loop-level change; the contract is "injected as soon as the hook resolves".
  ctx.on('agent/session-start', (agent, source) => {
    detached.track(runPoint('SessionStart', source, { ...base(agent, 'SessionStart', model), source }, { agent, plainStdoutAsContext: true, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context) agent.inject(context.content, { source: context.source })
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-codex: SessionStart hook failed: ${String(error)}`) }))
  })

  // UserPromptSubmit → PromptDecision. Codex can only BLOCK (no allow/ask).
  ctx.on('agent/prompt-submit', async (agent, content, _source, next): Promise<PromptDecision> => {
    const turn = lastTurn(agent)
    const merged = await runPoint('UserPromptSubmit', '', { ...turnBase(agent, 'UserPromptSubmit', model), prompt: blocksToText(content) }, { agent, turn, plainStdoutAsContext: true })
    if (merged.decision === 'deny') return { kind: 'block', reason: merged.reason ?? 'blocked by UserPromptSubmit hook' }
    // Context alone is not a veto: DELEGATE so a later prompt-submit listener can
    // still block/rewrite, then fold our context onto its decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'allow') return downstream
    return {
      kind: 'allow',
      ...downstream.content !== undefined ? { content: downstream.content } : {},
      additionalContext: concatContext(ours, downstream.additionalContext),
    }
  })

  // PreToolUse → PreToolDecision. Codex blocks only (no allow/ask honored).
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, ...exec.signal ? { signal: exec.signal } : {} })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    return next()
  })

  // PostToolUse → PostToolDecision (block with feedback, or attach context).
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(exec, result, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, ...exec.signal ? { signal: exec.signal } : {} })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContext: context } : {} }
    }
    // Context alone is not a veto: DELEGATE, then fold our context onto the
    // downstream decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContext: concatContext(context, downstream.additionalContext) }
    }
    return {
      kind: 'accept',
      ...downstream.content !== undefined ? { content: downstream.content } : {},
      additionalContext: concatContext(context, downstream.additionalContext),
    }
  })

  // Stop → ContinuationDecision. A blocking Stop hook forces continuation.
  // TODO(stop-loop-guard): like CC, a Stop hook that unconditionally blocks would
  // force-continue every step (`stop_hook_active` is always false here); the
  // loop-guard (stop_hook_active + a max-consecutive cap) is deferred.
  ctx.on('agent/turn-continuation', async (agent, turn, _default, next): Promise<ContinuationDecision> => {
    const merged = await runPoint('Stop', '', { ...turnBase(agent, 'Stop', model), stop_hook_active: false, last_assistant_message: null }, { agent, turn })
    if (merged.decision === 'deny') {
      // A blocking Stop hook forces continuation; a block with no reason (exit 2,
      // empty stderr) still forces it — fall back to a generic steering line
      // rather than letting the turn stop.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      return { action: 'continue', reason: { content: [{ type: 'text', text }], source: PLUGIN_SOURCE } }
    }
    return next()
  })
}

// --- Codex DIALECT payloads: snake_case, model on every event, turn_id on
// turn-scoped events. ---

function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- the `: 0` arm is a defensive fallback: when an agent is
     present, lastTurn is only called from the mid-turn seams, which always run
     inside an open turn, so `last` is always a turn/start here. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

/** Base fields on every Codex payload (no turn_id). */
function base(agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: null,
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
    model,
    permission_mode: 'default',
  }
}

/** Base + turn_id, for the turn-scoped events (PreToolUse/PostToolUse/UserPromptSubmit/Stop). */
function turnBase(agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return { ...base(agent, event, model), turn_id: String(lastTurn(agent)) }
}

/** Extract a `command` string from a tool call's parsed arguments, else ''. */
function commandOf(args: unknown): string {
  if (typeof args === 'object' && args !== null && 'command' in args) {
    const command: unknown = args.command
    if (typeof command === 'string') return command
  }
  return ''
}

function preToolPayload(exec: ToolExecution, model: string): Record<string, unknown> {
  // `tool_name` is the REAL tool name (matching the `exec.name` matcher subject);
  // a hardcoded constant would disagree with what the matcher tests and make a
  // config's tool matcher never fire. `tool_input` keeps Codex's `{ command }`
  // shape (its shell payload), derived from the call's `command` arg when present.
  return { ...turnBase(exec.agent, 'PreToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId }
}

function postToolPayload(exec: ToolExecution, result: ToolExecutionResult, model: string): Record<string, unknown> {
  return { ...turnBase(exec.agent, 'PostToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
