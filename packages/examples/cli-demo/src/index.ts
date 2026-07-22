/**
 * Headless one-shot app composition: the default agent spine, JSONL session
 * persistence, and one fresh top-level agent. The CLI driver owns task
 * submission and output; the app deliberately mounts no interactive or logging
 * front door so stdout remains protocol-pure.
 * @module @deepseek-ai/dsh-cli-demo
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import SessionPersistenceJsonl, {
  JsonlCompressionSchema,
  type JsonlCompression,
} from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as sessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import * as workspaceContext from '@deepseek-ai/dsh-workspace-context'

const DEFAULT_PERSISTENCE_ROOT = './.sessions'

export const name = 'cli-demo'

/** App config forwarded to the spine, configured agent, and JSONL backend. */
export interface Config {
  /** Provider route for the configured agent. */
  provider: string
  /** Model name for the configured agent; a matching adapter must be registered. */
  model: string
  /** Bundled agent-loop concurrency cap; `1` is serial and omission uses its default. */
  maxParallelToolCalls?: number
  /** Deployment persona forwarded to the system-prompt plugin. */
  persona?: string
  /** Explicit model-facing tool order forwarded to the system-prompt plugin. */
  toolOrder?: string[]
  /** Tool-registry presentation config forwarded through agent-spine-demo. */
  tools?: ToolsConfig
  /** DeepSeek Harness home directory exposed to bash and used for local skill discovery. */
  dshHome?: string
  /** Fallback session-title limits forwarded through agent-spine-demo. */
  sessionTitle?: NonNullable<agentCore.Config['sessionTitle']>
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** JSONL artifact encoding; defaults to checksummed Zstandard frames. */
  persistenceCompression?: JsonlCompression
  /** Skill registry, local-provider, and model-facing consumer config. */
  skills?: agentCore.SkillConfig
  /** Model-facing bash tool config forwarded through agent-spine-demo. */
  toolBash?: NonNullable<agentCore.Config['toolBash']>
  /** Generic background-task control-tool config forwarded through agent-spine-demo. */
  toolTasks?: NonNullable<agentCore.Config['toolTasks']>
  /** Bounded transient model-request retry policy forwarded through agent-spine-demo. */
  llmRetry?: NonNullable<agentCore.Config['llmRetry']>
  /** Controls automatic AGENTS.md/CLAUDE.md loading; configure a byte budget or set `false`. */
  workspaceContext: agentCore.Config['workspaceContext']
}

// Each front door keeps a complete Loader schema so its deployment contract is
// readable without a cross-package config facade.
/* jscpd:ignore-start */
export const Config: z<Config> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  maxParallelToolCalls: z.number().step(1).min(1),
  persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
  persistenceCompression: JsonlCompressionSchema,
  persona: z.string(),
  dshHome: z.string(),
  sessionTitle: agentCore.SessionTitleConfigSchema,
  skills: agentCore.SkillConfigSchema,
  // Absent means lexicographic order; schemastery's native array default is [].
  toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  tools: ToolRegistry.Config,
  toolBash: agentCore.ToolBashConfigSchema,
  toolTasks: z.union([z.const(false), agentCore.ToolTasksConfigSchema]),
  llmRetry: agentCore.LlmRetryConfigSchema,
  workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
})
/* jscpd:ignore-end */

/**
 * Compose the UI-less spine, a fresh top-level agent rooted at the process cwd,
 * and JSONL persistence. Swappable adapters, executors, and product tools stay
 * in the leaf `cordis.yml`.
 * @param ctx - app context that owns the composed child plugins.
 * @param config - validated app configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(agentCore, {
    ...agentCore.pickSpineConfig(config),
    agents: [{ id: SessionId('main'), provider: config.provider, model: config.model, cwd: process.cwd() }],
  })
  ctx.plugin(SessionPersistenceJsonl, {
    root: config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT,
    ...(config.persistenceCompression === undefined ? {} : { compression: config.persistenceCompression }),
  })
  ctx.plugin(sessionCheckpointPolicy)
}
