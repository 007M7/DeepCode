/**
 * Default executor-less, UI-less agent spine. It bundles the common services,
 * concrete loop, local skill provider, and model-facing bash/skill consumers;
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
import * as invariants from '@deepseek-ai/dsh-invariants'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import AgentLoop, { type Config as AgentLoopConfig } from '@deepseek-ai/dsh-agent-loop'

export const name = 'agent-spine-demo'

/** Skill bundle config forwarded to the registry, local provider, and model-facing consumer. */
export interface SkillConfig {
  /** Registry-level discovery cache settings. */
  registry?: SkillRegistryConfig
  /** Local filesystem skill provider settings. */
  local?: SkillLocal.Config
  /** Model-facing skill catalog and tool settings. */
  tool?: toolSkill.Config
}

/**
 * Bundle config: each field forwarded verbatim to the child that owns it — `agents` to the
 * agent loop (an app that pre-creates no agents, like the ACP bridge, omits it),
 * `persona` and `toolOrder` to the system-prompt plugin (the deployment's persona section and
 * the explicit model-facing tool order), the `tools` object to the tool registry (its
 * presentation `mode`), and `skills` to the skill registry/local provider/tool consumer.
 * The schema intersects the owners' schemas, which supply defaults for every
 * optional input and keep validation from drifting.
 */
export interface Config {
  /** The agent-loop `agents` list (see dsh-agent-loop's `Config`). */
  agents?: AgentLoopConfig['agents']
  /** The deployment persona (see dsh-system-prompt's `Config`). */
  persona?: SystemPromptConfig['persona']
  /** The explicit model-facing tool order (see dsh-system-prompt's `Config`). */
  toolOrder?: SystemPromptConfig['toolOrder']
  /** The tool registry's config — its presentation `mode` (see dsh-tools' `Config`). */
  tools?: ToolsConfig
  /** Skill registry, local provider, and model-facing consumer config. */
  skills?: SkillConfig
}

/** The skill config schema exported for app packages that forward `skills`. */
export const SkillConfigSchema: z<SkillConfig> = z.object({
  registry: SkillService.Config,
  local: SkillLocal.Config,
  tool: toolSkill.Config,
})

/** Intersect the owners' schemas so validation + defaulting stay identical. */
export const Config = z.intersect([
  AgentLoop.Config,
  SystemPrompt.Config,
  z.object({ tools: ToolRegistry.Config, skills: SkillConfigSchema }),
]) as unknown as z<Config>

/**
 * Load the spine. Each `ctx.plugin(...)` mounts one child of the bundle fiber;
 * `agent-loop` receives the forwarded `agents` list and `system-prompt` the
 * forwarded `persona` and `toolOrder`. Load order is irrelevant (cordis pends
 * each fiber on its `inject` until the services it needs exist), but the
 * listing mirrors the dependency layering for readability: the LLM vocabulary
 * and core registries first, then the dev tripwire and the bash tool consumer,
 * then the loop that drives them.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(Timer)
  ctx.plugin(LlmService)
  ctx.plugin(SessionStore)
  // Owner schemas resolve defaults; forward toolOrder only when explicitly set.
  ctx.plugin(SystemPrompt, {
    persona: config.persona ?? '',
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
  })
  ctx.plugin(ToolRegistry, config.tools ?? {})
  ctx.plugin(SkillService, config.skills?.registry ?? {})
  ctx.plugin(SkillLocal, config.skills?.local ?? {})
  ctx.plugin(AgentRegistry)
  ctx.plugin(invariants)
  ctx.plugin(toolBash)
  ctx.plugin(toolSkill, config.skills?.tool ?? {})
  ctx.plugin(AgentLoop, { agents: config.agents ?? [] })
}
