/**
 * Headless one-shot app composition: the default agent spine, JSONL session
 * persistence, and one pre-created `main` agent. The CLI driver owns task
 * submission and output; the app deliberately mounts no interactive or logging
 * front door so stdout remains protocol-pure.
 * @module @deepseek-ai/dsh-cli-demo
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { AgentId } from '@deepseek-ai/dsh-agent'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const DEFAULT_PERSISTENCE_ROOT = './.sessions'

export const name = 'cli-demo'

/** App config forwarded to the spine, pre-created agent, and JSONL backend. */
export interface Config {
  /** Model name for the `main` agent; a matching adapter must be registered. */
  model: string
  /** Deployment persona forwarded to the system-prompt plugin. */
  persona?: string
  /** Explicit model-facing tool order forwarded to the system-prompt plugin. */
  toolOrder?: string[]
  /** Tool-registry presentation config forwarded through agent-spine-demo. */
  tools?: ToolsConfig
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** Skill registry, local-provider, and model-facing consumer config. */
  skills?: agentCore.SkillConfig
}

export const Config: z<Config> = z.object({
  model: z.string().required(),
  persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
  persona: z.string(),
  skills: agentCore.SkillConfigSchema,
  // Absent means lexicographic order; schemastery's native array default is [].
  toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  tools: ToolRegistry.Config,
})

/**
 * Compose the UI-less spine, a fresh `main` agent rooted at the process cwd,
 * and JSONL persistence. Swappable adapters, executors, and product tools stay
 * in the leaf `cordis.yml`.
 * @param ctx - app context that owns the composed child plugins.
 * @param config - validated app configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const spineConfig: agentCore.Config = {
    agents: [{ id: AgentId('main'), model: config.model, cwd: process.cwd() }],
  }
  if (config.persona !== undefined) spineConfig.persona = config.persona
  if (config.toolOrder !== undefined) spineConfig.toolOrder = config.toolOrder
  if (config.tools !== undefined) spineConfig.tools = config.tools
  if (config.skills !== undefined) spineConfig.skills = config.skills
  ctx.plugin(agentCore, spineConfig)
  ctx.plugin(SessionPersistenceJsonl, { root: config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT })
}
