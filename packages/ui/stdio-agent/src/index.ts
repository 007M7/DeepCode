/**
 * The stdio chat app: the default agent spine ({@link @deepseek-ai/dsh-agent-core}) plus the
 * coupled front-door cluster a terminal chat needs — a console logger, the independently
 * packaged readline UI, JSONL session persistence, the user-interaction seam with its
 * `ask_user_question` tool, and a pre-created `main` agent the UI drives.
 * Swappable adapters, executors, optional tools, and HMR stay in the leaf. This
 * Loader plugin intentionally exposes named exports only; a default export
 * would hide its `Config` schema (see docs/postmortem/0001).
 * @module @deepseek-ai/dsh-stdio-agent
 */

import type { Context } from 'cordis'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import z from 'schemastery'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import * as agentCore from '@deepseek-ai/dsh-agent-core'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as uiStdio from '@deepseek-ai/dsh-stdio'

export const name = 'stdio-agent'

/**
 * App config: the swappable per-demo values, each routed to where the app wires
 * it. `model`/`resumeSessionId` configure the pre-created `main` agent (through
 * {@link @deepseek-ai/dsh-agent-core}'s forwarded `agents` list); `persona` is
 * the deployment persona (forwarded to the system-prompt plugin); `toolOrder`
 * is the explicit model-facing tool order (forwarded to the system-prompt plugin);
 * fresh sessions use `process.cwd()` as their workspace cwd; resumed sessions
 * keep their persisted cwd. `persistenceRoot` is the JSONL backend's directory;
 * `welcome` is the UI banner.
 */
export interface Config {
  /** Model name for the `main` agent (must have a registered adapter). */
  model: string
  /** Deployment persona (the system-prompt plugin's `persona` config). */
  persona?: string
  /** Explicit model-facing tool order (the system-prompt plugin's `toolOrder` config; see dsh-system-prompt). */
  toolOrder?: string[]
  /** Tool-registry config — its presentation `mode` (forwarded through agent-core; see dsh-tools). */
  tools?: ToolsConfig
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** stdin-chat banner printed once on start. Defaults to `'ready.'`. */
  welcome?: string
  /** Skill registry, local-provider, and model-facing consumer config forwarded to agent-core. */
  skills?: agentCore.SkillConfig
  /**
   * If set, the `main` agent RESUMES this persisted session id instead of
   * starting fresh. Sourced from an env var in the leaf `cordis.yml`
   * (`resumeSessionId: !!js process.env.RESUME_SESSION_ID`).
   */
  resumeSessionId?: string
}

export const Config: z<Config> = z.object({
  model: z.string().required(),
  persona: z.string(),
  // The array default is forced to undefined: ABSENT means "lexicographic
  // order" (the owning dsh-system-prompt schema does the same), while
  // schemastery's native [] default would read as an invalid configured list.
  toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  tools: ToolRegistry.Config,
  // TODO(single-default-literal): share these schema defaults and defensive
  // apply() fallbacks through named constants while retaining both boundaries.
  persistenceRoot: z.string().default('./.sessions'),
  welcome: z.string().default('ready.'),
  skills: agentCore.SkillConfigSchema,
  resumeSessionId: z.string(),
})

/**
 * Compose the spine with the stdio front door. The console logger comes first
 * (infra), then the agent-core bundle pre-creating the `main` agent from this
 * app's `model`/`resumeSessionId` with the deployment `persona`, then the JSONL
 * backend, then the readline UI bound to `main`. The `hmr` dev-reload plugin is
 * a leaf concern (see the module doc), so it is not mounted here.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ConsoleExporter)
  ctx.plugin(agentCore, {
    ...config.persona !== undefined ? { persona: config.persona } : {},
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
    ...config.tools !== undefined ? { tools: config.tools } : {},
    agents: [{
      id: AgentId('main'),
      model: config.model,
      cwd: process.cwd(),
      ...config.resumeSessionId !== undefined ? { resumeSessionId: SessionId(config.resumeSessionId) } : {},
    }],
    ...config.skills !== undefined ? { skills: config.skills } : {},
  })
  ctx.plugin(SessionPersistenceJsonl, { root: config.persistenceRoot ?? './.sessions' })
  ctx.plugin(UserInteractionService)
  ctx.plugin(toolAskUser)
  ctx.plugin(uiStdio, { welcome: config.welcome ?? 'ready.', agent: 'main' })
}
