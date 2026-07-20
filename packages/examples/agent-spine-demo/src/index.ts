/**
 * Default executor-less, UI-less agent spine. It bundles the common services,
 * background-task registry and controls, concrete loop, local skill and
 * workspace-context providers, and model-facing bash/skill consumers;
 * deployments still choose the LLM adapter, bash executor, and presentation.
 * The plugin intentionally exposes named exports only because Loader default
 * unwrapping would discard its `Config` schema (see docs/postmortem/0001).
 * @module @deepseek-ai/dsh-agent-spine-demo
 */

import type { Context } from 'cordis'
import Timer from '@cordisjs/plugin-timer'
import z from 'schemastery'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt, { type Config as SystemPromptConfig } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import SkillService, { type Config as SkillRegistryConfig } from '@deepseek-ai/dsh-skill'
import * as SkillLocal from '@deepseek-ai/dsh-skill-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import TaskService from '@deepseek-ai/dsh-tasks'
import * as invariants from '@deepseek-ai/dsh-invariants'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as workspaceContext from '@deepseek-ai/dsh-workspace-context'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import * as toolTasks from '@deepseek-ai/dsh-tool-tasks'
import AgentLoop, { type Config as AgentLoopConfig } from '@deepseek-ai/dsh-agent-loop'
import { resolveDshHome } from '@deepseek-ai/dsh-home'

export const name = 'agent-spine-demo'

/** Skill bundle config forwarded to the registry, local provider, and model-facing consumer. */
export interface SkillConfig {
  /** Mount the bundled local skill provider and model-facing skill tool (default true). */
  enabled?: boolean
  /** Registry-level discovery cache settings. */
  registry?: SkillRegistryConfig
  /** Local filesystem skill provider settings. */
  local?: SkillLocal.Config
  /** Model-facing skill catalog and tool settings. */
  tool?: toolSkill.Config
}

/**
 * Bundle config: each field forwarded verbatim to the child that owns it —
 * `agents` to the agent loop (an app that pre-creates no agents, like the ACP
 * bridge, simply omits it), `persona` and `toolOrder` to the system-prompt
 * plugin (the deployment's persona section and the explicit model-facing tool
 * order), the `tools` object to the tool registry (its presentation `mode`),
 * `dshHome` to bash environment and local skill discovery, `skills` to the
 * skill registry/local provider/tool consumer, `workspaceContext` to the
 * workspace-context loader, and `toolBash`/`toolTasks` to the model-facing tool
 * plugins this bundle owns. Owner schemas supply defaults for optional input;
 * workspace context instead requires an explicit byte budget or `false` because
 * it changes model-visible input. Producer opt-in stays producer-local:
 * `toolBash` configures bash only; independently composed producers keep their
 * own config.
 */
export interface Config {
  /** The agent-loop `agents` list (see dsh-agent-loop's `Config`). */
  agents?: AgentLoopConfig['agents']
  /** Agent-loop concurrency cap; `1` is serial. */
  maxParallelToolCalls?: AgentLoopConfig['maxParallelToolCalls']
  /** The deployment persona (see dsh-system-prompt's `Config`). */
  persona?: SystemPromptConfig['persona']
  /** The explicit model-facing tool order (see dsh-system-prompt's `Config`). */
  toolOrder?: SystemPromptConfig['toolOrder']
  /** The tool registry's config — its presentation `mode` (see dsh-tools' `Config`). */
  tools?: ToolsConfig
  /** DeepSeek Harness home directory shared by shell context and local skill discovery. */
  dshHome?: string
  /** Workspace-context loader controls with an explicit byte budget; set `false` for hermetic prompts. */
  workspaceContext: workspaceContext.Config | false
  /** Skill registry, local provider, and model-facing consumer config. */
  skills?: SkillConfig
  /** Model-facing bash tool config, including this producer's background opt-in. */
  toolBash?: toolBash.Config
  /** Generic background-task controls; set false to keep the task service without model-facing task tools. */
  toolTasks?: toolTasks.Config | false
}

/** The skill config schema exported for app packages that forward `skills`. */
export const SkillConfigSchema: z<SkillConfig> = z.object({
  enabled: z.boolean().default(true),
  registry: SkillService.Config,
  local: SkillLocal.Config,
  tool: toolSkill.Config,
})

/** The bash-tool config schema exported for app packages that forward `toolBash`. */
export const ToolBashConfigSchema: z<toolBash.Config> = toolBash.Config

/** The task-control-tool config schema exported for app packages that forward `toolTasks`. */
export const ToolTasksConfigSchema: z<toolTasks.Config> = toolTasks.Config

/** Intersect the owners' schemas so validation + defaulting stay identical. */
export const Config = z.intersect([
  AgentLoop.Config,
  SystemPrompt.Config,
  z.object({
    tools: ToolRegistry.Config,
    dshHome: z.string(),
    skills: SkillConfigSchema,
    workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
    toolBash: ToolBashConfigSchema,
    toolTasks: z.union([z.const(false), ToolTasksConfigSchema]),
  }) as unknown as z<Pick<Config, 'tools' | 'dshHome' | 'skills' | 'workspaceContext' | 'toolBash' | 'toolTasks'>>,
]) as unknown as z<Config>

/**
 * Copy the bundle-owned fields from an app config without leaking front-door settings.
 * @param config - App config containing the shared spine fields.
 * @returns The fields accepted by this bundle, preserving optional absence.
 */
export function pickSpineConfig(config: Omit<Config, 'agents'>): Omit<Config, 'agents'> {
  return {
    ...config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {},
    ...config.persona !== undefined ? { persona: config.persona } : {},
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
    ...config.tools !== undefined ? { tools: config.tools } : {},
    ...config.dshHome !== undefined ? { dshHome: config.dshHome } : {},
    workspaceContext: config.workspaceContext,
    ...config.skills !== undefined ? { skills: config.skills } : {},
    ...config.toolBash !== undefined ? { toolBash: config.toolBash } : {},
    ...config.toolTasks !== undefined ? { toolTasks: config.toolTasks } : {},
  }
}

/**
 * Load the spine. Each `ctx.plugin(...)` mounts one child of the bundle fiber;
 * `agent-loop` receives the forwarded `agents` list and `system-prompt` the
 * forwarded `persona` and `toolOrder`. Workspace-context receives its own
 * explicitly forwarded config. Load order is irrelevant (cordis
 * pends each fiber on its `inject` until the services it needs exist), but the
 * listing mirrors the dependency layering for readability: the LLM vocabulary
 * and core registries first, then extension plugins that wrap request/tool
 * seams, then the loop that drives them.
 */
export function apply(ctx: Context, config: Config): void {
  const nestedDshHome = config.skills?.local?.dshHome
  if (config.dshHome !== undefined && nestedDshHome !== undefined
    && resolveDshHome(config.dshHome) !== resolveDshHome(nestedDshHome)) {
    throw new Error('agent-spine-demo: dshHome and skills.local.dshHome must resolve to the same directory')
  }
  const dshHome = resolveDshHome(config.dshHome ?? nestedDshHome)

  ctx.plugin(Timer)
  ctx.plugin(LlmService)
  ctx.plugin(SessionStore)
  // Owner schemas resolve defaults; forward toolOrder only when explicitly set.
  ctx.plugin(SystemPrompt, {
    persona: config.persona ?? '',
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
  })
  ctx.plugin(ToolRegistry, config.tools ?? {})
  const skillsEnabled = config.skills?.enabled ?? true
  if (skillsEnabled) {
    ctx.plugin(SkillService, config.skills?.registry ?? {})
    ctx.plugin(SkillLocal, Object.assign({}, config.skills?.local, { dshHome }))
  }
  ctx.plugin(AgentRegistry)
  ctx.plugin(TaskService)
  ctx.plugin(invariants)
  ctx.plugin(toolBash, Object.assign({}, config.toolBash, { dshHome }))
  if (config.workspaceContext !== false) {
    ctx.plugin(workspaceContext, config.workspaceContext)
  }
  // Both plugins prepend session-prefix messages. Registration order is the
  // rendered order, so workspace instructions must precede the skill catalog.
  if (skillsEnabled) ctx.plugin(toolSkill, config.skills?.tool ?? {})
  if (config.toolTasks !== false) ctx.plugin(toolTasks, config.toolTasks ?? {})
  ctx.plugin(AgentLoop, {
    agents: config.agents ?? [],
    ...config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {},
  })
}
