/**
 * Out-of-process ACP subagent backend. Each child has its own process, session, model, and
 * tools, so it shares no Cordis context, ignores `request.parent`, and advertises no parent-
 * enforced start capabilities. This plugin uses named exports only; a default would hide its
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-acp
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { SubagentCapabilities, SubagentProvider, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { type AcpRunSpec, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, type PermissionPolicy, startAcpRun } from './run.ts'

export const name = 'subagent-acp'
export const inject = ['subagents']

/** Config: how to spawn and drive the child ACP agent process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `acp`). */
  providerName: string
  /** The executable to spawn for each run (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * Working directory for the child process and its ACP session. Defaults to
   * the parent process's cwd when omitted.
   */
  cwd?: string
  /**
   * How to auto-answer the child's `session/request_permission` prompts:
   * `reject` (default — decline every prompt) or `allow` (approve via the first
   * allow-shaped option). The first cut surfaces no prompt to a human.
   */
  permission: PermissionPolicy
  /**
   * Extra environment variables for the child process — e.g. the child
   * harness's own `DEEPSEEK_API_KEY`. Forwarded on top of a credential-scrubbed
   * copy of the parent env, so an explicit key here reaches the child while
   * ambient secrets do not leak implicitly.
   */
  env: Record<string, string>
  /**
   * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
   * window to flush persistence and tear down its own nested subprocesses
   * before the parent escalates to a signal.
   */
  disposeEofGraceMs?: number
  /** Grace period (ms) between `SIGTERM` and the `SIGKILL` escalation on dispose. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('acp'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  cwd: z.string(),
  permission: z.union(['allow', 'reject'] as const).default('reject'),
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/** A dispose grace must be a positive finite number (it bounds the teardown wait). */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`subagent-acp: ${name} must be a positive finite number`)
  }
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

/**
 * The ACP provider. Advertises NO start-time capabilities: an out-of-process
 * child cannot honor `outputSchema`/`maxDepth`/`toolFilter` (the service rejects
 * a request needing any of them before `start` runs).
 */
class AcpProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  // Context contract: an out-of-process ACP child starts fresh — no parent conversation crosses the process boundary.
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  start(request: SubagentStartRequest) {
    const spec: AcpRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd ?? process.cwd(),
      permission: this.config.permission,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      onError: (error, stopReason) => {
        // The seam forbids `result` rejecting, so a child-level failure is
        // flattened to a stop reason — preserve it here rather than losing it.
        this.ctx.logger.warn(`subagent-acp "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startAcpRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs)
  ctx.subagents.registerProvider(new AcpProvider(resolved.providerName, ctx, resolved))
}
