/**
 * Full-screen terminal app: the default agent spine ({@link @deepseek-ai/dsh-agent-spine-demo})
 * plus human commands, JSONL persistence, keyboard-backed user interaction,
 * and one pre-created agent whose exact session identity the TUI drives. Swappable adapters,
 * executors, optional tools, and HMR stay in the leaf. This Loader plugin
 * intentionally exposes named exports only; a default export would hide its
 * `Config` schema (see docs/postmortem/0001).
 * @module @deepseek-ai/dsh-tui-demo
 */

import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import CommandService from '@deepseek-ai/dsh-commands'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import * as workspaceContext from '@deepseek-ai/dsh-workspace-context'
import SessionPersistenceJsonl, {
  JsonlCompressionSchema,
  type JsonlCompression,
} from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as uiTui from '@deepseek-ai/dsh-tui'

export const name = 'tui-demo'
const DEFAULT_PERSISTENCE_ROOT = './.sessions'
const DEFAULT_WELCOME = 'ready.'

/** App config routed to the spine, TUI, configured agent, and JSONL backend. */
export interface Config {
  /** Provider route for the `main` agent. */
  provider: string
  /** Model name for the `main` agent; a matching adapter must be registered. */
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
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** JSONL artifact encoding; defaults to checksummed Zstandard frames. */
  persistenceCompression?: JsonlCompression
  /** TUI subtitle rendered on start. Defaults to `ready.`. */
  welcome?: string
  /** Full-screen TUI presentation settings. */
  ui?: uiTui.TuiConfig
  /** Skill registry, local-provider, and model-facing consumer config. */
  skills?: agentCore.SkillConfig
  /** Model-facing bash tool config forwarded through agent-spine-demo. */
  toolBash?: NonNullable<agentCore.Config['toolBash']>
  /** Generic background-task controls forwarded through agent-spine-demo; set false to omit them. */
  toolTasks?: NonNullable<agentCore.Config['toolTasks']>
  /** Persisted session id to resume instead of creating a fresh session. */
  resumeSessionId?: string
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
  persona: z.string(),
  // Absent means lexicographic order; schemastery's native array default is [].
  toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  tools: ToolRegistry.Config,
  dshHome: z.string(),
  persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
  persistenceCompression: JsonlCompressionSchema,
  welcome: z.string().default(DEFAULT_WELCOME),
  ui: uiTui.TuiConfigSchema,
  skills: agentCore.SkillConfigSchema,
  toolBash: agentCore.ToolBashConfigSchema,
  toolTasks: z.union([z.const(false), agentCore.ToolTasksConfigSchema]),
  resumeSessionId: z.string(),
  workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
})
/* jscpd:ignore-end */

/**
 * Compose the spine, TUI, JSONL persistence, and user-question tool around one
 * exact fresh or resumed session identity. The TUI subscribes to startup
 * failures before the spine creates the agent.
 * @param ctx - context receiving the app's child plugins.
 * @param config - validated app configuration.
 */
export function composeTuiApp(ctx: Context, config: Config): void {
  const resumeSessionId = config.resumeSessionId === '' ? undefined : config.resumeSessionId
  const sessionId = SessionId(resumeSessionId ?? `main-session-${randomUUID()}`)
  ctx.plugin(CommandService)
  ctx.plugin(SessionPersistenceJsonl, {
    root: config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT,
    ...(config.persistenceCompression === undefined ? {} : { compression: config.persistenceCompression }),
  })
  ctx.plugin(UserInteractionService)
  ctx.plugin(uiTui, {
    ...config.ui,
    welcome: config.welcome ?? DEFAULT_WELCOME,
    sessionId,
  })
  ctx.plugin(agentCore, {
    ...agentCore.pickSpineConfig(config),
    agents: [{
      id: SessionId('main'),
      provider: config.provider,
      model: config.model,
      cwd: process.cwd(),
      ...resumeSessionId === undefined ? { sessionId } : { resumeSessionId: sessionId },
    }],
  })
  ctx.plugin(toolAskUser)
}

/**
 * Compose the configured full-screen terminal app.
 * @param ctx - context receiving the app's child plugins.
 * @param config - validated app configuration.
 */
export function apply(ctx: Context, config: Config): void {
  composeTuiApp(ctx, config)
}
