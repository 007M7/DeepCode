/**
 * Core spine composition for the dsh host: mounts the harness core plugins
 * one by one (each awaited so a load failure surfaces deterministically at
 * boot, unlike bundle plugins whose children mount unawaited).
 */

import { Context } from 'cordis'
import Timer from '@cordisjs/plugin-timer'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import TaskService from '@deepseek-ai/dsh-tasks'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import * as toolTasks from '@deepseek-ai/dsh-tool-tasks'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as fsPolicy from '@deepseek-ai/dsh-fs-policy'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import SkillService from '@deepseek-ai/dsh-skill'
import * as SkillLocal from '@deepseek-ai/dsh-skill-local'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CompactBasic from '@deepseek-ai/dsh-compact-basic'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import WorkflowWorkerthread from '@deepseek-ai/dsh-workflow-workerthread'
import * as toolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import * as timeoutPolicy from '@deepseek-ai/dsh-timeout-policy'
import SpillLocal from '@deepseek-ai/dsh-spill-local'
import * as spillPolicy from '@deepseek-ai/dsh-spill-policy'

/** Options for bootHost — the assembly-layer composition knobs. */
export interface BootHostOptions {
  /** Root directory for JSONL session persistence. */
  persistenceRoot: string
  /** Default provider route for created/resumed agents (defaults to 'deepseek', the only adapter bootHost registers). */
  provider?: string
  /** Default model id (defaults to 'deepseek-v4-flash', matching the demos). */
  model?: string
  /**
   * Default project directory for sessions created without an explicit cwd
   * (defaults to the host process working directory). A session's cwd is its
   * project path — a per-session choice, not a host property; this option only
   * supplies the value used when the creator does not choose one.
   */
  cwd?: string
}

/** Host-level default agent routing: the single source injected on create and reported by host.describe. */
export interface HostDefaults {
  provider: string
  model: string
  /** Default project directory for new sessions whose create request carries no cwd. */
  cwd: string
}

/** Booted host handle: composed root context + resolved defaults + disposer. */
export interface HostHandle {
  /** Root context with the full plugin assembly mounted. */
  ctx: Context
  /** Resolved default agent routing (options ?? built-in fallbacks). */
  defaults: HostDefaults
  /** Tear down the whole plugin tree. */
  dispose(): Promise<void>
}

/**
 * Compose the harness host plugin assembly (the one place deciding which plugins mount and
 * with what defaults — shells must not alter the assembly).
 * @param options - persistence root and optional default provider/model.
 * @returns the booted handle (ctx + defaults + dispose).
 */
export async function bootHost(options: BootHostOptions): Promise<HostHandle> {
  const defaults: HostDefaults = {
    provider: options.provider ?? 'deepseek',
    model: options.model ?? 'deepseek-v4-flash',
    cwd: options.cwd ?? process.cwd(),
  }
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TaskService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, {})
  await ctx.plugin(SessionPersistenceJsonl, { root: options.persistenceRoot, compression: 'none' })
  await ctx.plugin(LocalBashExecutor, {})
  // Tool suite mirroring the demo:repl composition (repl-agent/cordis.yml +
  // the agent-spine bundle) so web sessions get the same coding-agent tool
  // face; deviations are noted inline.
  await ctx.plugin(toolBash, {})
  await ctx.plugin(toolTodo)
  await ctx.plugin(toolTasks, {})
  // fs paths resolve against the host default project rather than the raw
  // process cwd — the same source create() injects into session.cwd.
  await ctx.plugin(FsLocal, { cwd: defaults.cwd })
  await ctx.plugin(fsPolicy)
  await ctx.plugin(toolFs, {})
  await ctx.plugin(toolFsSearch, {})
  // Skill stack with the demo default dshHome (~/.dsh via resolveDshHome).
  await ctx.plugin(SkillService, {})
  await ctx.plugin(SkillLocal, {})
  await ctx.plugin(toolSkill, {})
  // Request pressure + compaction (service-wide defaults, as in repl-agent).
  await ctx.plugin(TokenMeter)
  await ctx.plugin(CompactBasic)
  // Subagent spawn/fork backends and their two model-facing tool instances.
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(toolSubagent, { provider: 'spawn', toolName: 'subagent' })
  await ctx.plugin(toolSubagent, { provider: 'fork', toolName: 'subagent_fork' })
  await ctx.plugin(WorkflowWorkerthread, { provider: 'spawn' })
  await ctx.plugin(toolWorkflow, {})
  // Declared per-tool timeouts become enforced deadlines.
  await ctx.plugin(timeoutPolicy)
  // Oversized tool output spills to session-scoped files (repl-agent budget).
  await ctx.plugin(SpillLocal, {})
  await ctx.plugin(spillPolicy, { maxInlineBytes: 50000 })
  return { ctx, defaults, dispose: () => ctx.fiber.dispose() }
}
