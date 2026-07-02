/**
 * `dsh-hooks-claude` — a bridge plugin that runs a user's existing Claude Code
 * hook config (`hooks.json` / a settings file's `hooks` key) on the harness's
 * canonical interception seams. It is the CC DIALECT half of the hooks
 * subsystem: it owns CC's per-event stdin payloads, CC's env +
 * `${CLAUDE_PLUGIN_ROOT}` substitution, and the mapping from a hook's neutral
 * outcome onto the harness's typed Decisions. The dialect-agnostic primitives
 * (matcher, exit-code/stdout codec, `ctx.bash` execution, most-restrictive
 * merge, the `hook/*` events) come from `@deepseek-ai/dsh-hook-protocol`.
 *
 * A native cordis plugin could do everything this bridge does — more powerfully,
 * with typed returns and no serialization boundary. The bridge exists only to
 * run UNMODIFIED external CC hooks faithfully; anything bespoke should be a
 * native plugin on the same seams.
 *
 * Scope: the seven in-scope hook points (`SessionStart`, `UserPromptSubmit`,
 * `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`). Only
 * `type: 'command'` hooks run; the matcher group config + exit-code/stdout
 * protocol are byte-faithful to CC. `updatedInput` (tool-input rewrite) is
 * logged + warned, not honored (deferred — see the interception-seams RFC).
 *
 * @module @deepseek-ai/dsh-hooks-claude
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
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
// Side-effect type import: pulls in the `subagent/start` + `subagent/end` event
// declarations (declaration-merged into cordis `Events` by dsh-subagent) so the
// SubagentStart/SubagentStop listeners below type-check.
import type {} from '@deepseek-ai/dsh-subagent'
import { parseClaudeConfig, type ClaudeHookConfig } from './config.ts'

export const name = 'hooks-claude'
// `bash` is required to run hooks; the rest are read opportunistically via
// ctx.get so a deployment can load this bridge without every seam present.
export const inject = ['bash']

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * PROCESS-LEVEL: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process.
   * TODO(per-session-hook-config): per-session discovery of a project-local
   * `hooks.json` from each `session/new.cwd` is not yet implemented.
   */
  configPath: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(600_000),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude:${point}:${++handlerCounter}`
}

/** The `{kind:'plugin'}` source stamped on every context this bridge injects. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'hooks-claude' }

/** Truncate a stderr blob for the `hook/result` summary field. */
function summarize(stderr: string): string | undefined {
  const t = stderr.trim()
  if (t.length === 0) return undefined
  return t.length > 500 ? t.slice(0, 500) + '…' : t
}

export function apply(ctx: Context, config: Config): void {
  // --- Parse the config ONCE at load. A read/parse failure is contained: the
  // bridge logs and registers nothing rather than crashing boot (a typo'd path
  // must not take the agent down). ---
  let parsed: ClaudeHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(config.configPath, 'utf8'))
    const result = parseClaudeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    })
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`hooks-claude: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`hooks-claude: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`)
    return
  }

  const defaultTimeoutMs = config.defaultTimeoutMs ?? 600_000

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook into the session when one
   * is available (the mid-turn points always have an open turn). Returns the
   * merged outcome (a neutral, already-most-restrictive view) for the caller to
   * map onto its seam decision. `matchQuery` is the event's matcher subject
   * (tool name, session source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; signal?: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = parsed[point] ?? []
    const outputs: HookOutput[] = []
    // Run the hook in the AGENT'S session workspace (the `session/new` cwd on the
    // session header), not the executor default (the ACP server's launch dir).
    // A hook that does `pwd`, reads a relative file, or writes a marker must
    // operate in the user's project tree. Absent for a no-agent run (falls back
    // to the executor default).
    const workdir = opts.agent?.session.header.cwd
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to
    // the session workspace (the same dir the hook RUNS in). Claude Code always
    // exports this var, and common unmodified hooks reference `$CLAUDE_PROJECT_DIR`
    // (shell expansion at run time) for project-relative paths — leaving it empty
    // in the default ACP wiring (no `projectDir` configured) would break them even
    // though the bridge already knows the workspace. Absent only for a no-agent run
    // with no configured projectDir (nothing to point at).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.bash, hook, {
          payload,
          ...hookEnv ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          ...opts.signal ? { signal: opts.signal } : {},
          defaultTimeoutMs,
          trailingNewline: true,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`hooks-claude: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-claude: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          const stderrSummary = summarize(output.stderr)
          appendHookResult(session, {
            turn: opts.turn, point, handlerId,
            decision: output.decision ?? (output.continue === false ? 'stop' : 'pass'),
            ...output.exitCode !== undefined ? { exitCode: output.exitCode } : {},
            ...stderrSummary !== undefined ? { stderrSummary } : {},
            durationMs,
          })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  // TODO(hook-continue-false): the merge computes `merged.stop`/`stopReason` from
  // a hook's `continue:false`, but no seam below honors it — there is no
  // "hard-halt the whole agent" primitive on the interception seams yet (a
  // Decision can block/deny/steer a single point, not stop the run). Honoring it
  // needs that primitive; deferred with the loop-guard work. Until then a
  // `continue:false` hook still has its per-point effect (its decision/context),
  // and the halt request is recorded in the `hook/result` log but not acted on.

  /** Build a HookContext from accumulated additionalContext strings, or undefined when none. */
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
   * downstream plugin's text is still correctly framed as plugin context, not a
   * user prompt.
   */
  function concatContext(ours: HookContext, theirs: HookContext | undefined): HookContext {
    if (!theirs) return ours
    return { content: [...ours.content, ...theirs.content], source: ours.source }
  }

  // --- SessionStart: emit (cannot block). Inject any additionalContext into the
  // agent. The matcher subject is the source.
  // TODO(session-start-gating): `agent/session-start` is a SYNCHRONOUS emit and
  // this hook runs on a detached `.then`, so the injected context is BEST-EFFORT
  // — it is not guaranteed to land before the first turn reaches the model. A
  // slow hook can miss the first request (the context then arrives as a later
  // injection turn). Gating startup on the hook is a loop-level change deferred
  // to the interception seams; today the contract is "injected as soon as the
  // hook resolves", not "before the first request". ---
  ctx.on('agent/session-start', (agent, source) => {
    void runPoint('SessionStart', source, sessionStartPayload(agent, source), { agent })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context) agent.inject(context.content, { source: context.source })
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`hooks-claude: SessionStart hook failed: ${String(error)}`)
      })
  })

  // --- UserPromptSubmit → PromptDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/prompt-submit', async (agent, content, _source, next): Promise<PromptDecision> => {
    const turn = lastTurn(agent)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(agent, content), { agent, turn })
    if (merged.decision === 'deny') {
      return { kind: 'block', reason: merged.reason ?? 'blocked by UserPromptSubmit hook' }
    }
    // Our hooks did not block. DELEGATE (attaching context alone is not a veto):
    // a later `agent/prompt-submit` listener must still get to block or rewrite.
    // Then fold our additionalContext onto its decision — a downstream block wins
    // (a dropped prompt makes the context moot; `block` carries no context field).
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'allow') return downstream
    return {
      kind: 'allow',
      ...downstream.content !== undefined ? { content: downstream.content } : {},
      additionalContext: concatContext(ours, downstream.additionalContext),
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, ...exec.signal ? { signal: exec.signal } : {} })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(exec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, ...exec.signal ? { signal: exec.signal } : {} })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContext: context } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
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

  // --- Stop → ContinuationDecision. CC's Stop hook can force the conversation to
  // CONTINUE (block the stop) with stderr/reason as the continuation. No matcher.
  // TODO(stop-loop-guard): CC breaks an infinite force-continue with
  // `stop_hook_active` (set true once a Stop hook has already fired this run) plus
  // a max-consecutive cap; both are deferred. Today `stop_hook_active` is always
  // false, so a Stop hook that unconditionally blocks would force-continue every
  // step — a hook author must self-limit until the guard lands. ---
  ctx.on('agent/turn-continuation', async (agent, turn, _default, next): Promise<ContinuationDecision> => {
    const merged = await runPoint('Stop', '', stopPayload(agent), { agent, turn })
    if (merged.decision === 'deny') {
      // A blocking Stop hook forces continuation. It carries its reason as
      // next-step steering; a blocking hook that emitted no reason (exit 2, empty
      // stderr) still forces the turn to continue — the block is what matters, so
      // fall back to a generic steering line rather than letting the turn stop.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      return { action: 'continue', reason: { content: [{ type: 'text', text }], source: PLUGIN_SOURCE } }
    }
    return next()
  })

  // --- SubagentStart / SubagentStop: observe-only emits (the subagent seam is
  // observe-only this cut). A SubagentStart hook's additionalContext is injected
  // into the live child; SubagentStop only observes. Both look the live child up
  // so the hook runs in the child's session workspace and the payload carries
  // the child's session_id/cwd (see subagentPayload). The matcher subject is the
  // CC-default `agent_type` (SUBAGENT_TYPE) — the harness seam carries no
  // per-kind label, so a config's default/`*`/empty agent_type matcher fires and
  // a specific-kind matcher does not (documented in the RFC). ---
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    void runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload('SubagentStart', info, child), { ...child ? { agent: child } : {} })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context.content, { source: context.source })
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude: SubagentStart hook failed: ${String(error)}`) })
  })
  ctx.on('subagent/end', (info) => {
    // Look up the child (still recoverable: `subagent/end` fires from the
    // service's detached `.then` BEFORE the tool caller's `await run.result`
    // disposes it) so the hook runs in the child's cwd, not the server default.
    // No `.then`/inject follows (SubagentStop only observes), and no `turn` is
    // passed (so no `hook/*` log records), so runPoint has nothing that can
    // reject — no `.catch` is needed. Fire-and-forget.
    const child = ctx.get('agents')?.get(info.id)
    void runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload('SubagentStop', info, child), { ...child ? { agent: child } : {} })
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last (open or just-closed) turn number in the agent's log, or 0. */
function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- the `: 0` arm is a defensive fallback: lastTurn is only
     called from the mid-turn seams (prompt-submit/pre-/post-execute/continuation),
     which always run inside an open turn, so `last` is always a turn/start here. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function sessionStartPayload(agent: Agent, source: string): Record<string, unknown> {
  return { ...base(agent, 'SessionStart'), source }
}
function promptPayload(agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function preToolPayload(exec: ToolExecution): Record<string, unknown> {
  return { ...base(exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
function stopPayload(agent: Agent): Record<string, unknown> {
  return { ...base(agent, 'Stop'), stop_hook_active: false }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false this cut).
 */
function subagentPayload(event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
