/**
 * The stdio chat app: the default agent spine ({@link @deepseek-ai/dsh-agent-spine-demo}) plus the
 * coupled front-door cluster a terminal chat needs — a console logger, the independently
 * packaged readline UI, JSONL session persistence, the user-interaction seam with its
 * `ask_user_question` tool, and one pre-created agent whose exact shared
 * agent/session identity the UI drives under its `main` display label.
 * Swappable adapters, executors, optional tools, and HMR stay in the leaf. This
 * Loader plugin intentionally exposes named exports only; a default export
 * would hide its `Config` schema (see docs/postmortem/0001).
 * @module @deepseek-ai/dsh-stdio-demo
 */

import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import z from 'schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as uiStdio from '@deepseek-ai/dsh-stdio'

export const name = 'stdio-demo'

/**
 * App config: the swappable per-demo values, each routed to where the app wires
 * it. `model`/`resumeSessionId` configure the pre-created agent (through
 * {@link @deepseek-ai/dsh-agent-spine-demo}'s forwarded `agents` list); `persona` is
 * the deployment persona (forwarded to the system-prompt plugin); `toolOrder`
 * is the explicit model-facing tool order (forwarded to the system-prompt plugin);
 * fresh sessions use `process.cwd()` as their workspace cwd; resumed sessions
 * keep their persisted cwd. `persistenceRoot` is the JSONL backend's directory;
 * `welcome` is the UI banner.
 */
export interface Config {
  /** Model name for the pre-created agent (must have a registered adapter). */
  model: string
  /** Deployment persona (the system-prompt plugin's `persona` config). */
  persona?: string
  /** Explicit model-facing tool order (the system-prompt plugin's `toolOrder` config; see dsh-system-prompt). */
  toolOrder?: string[]
  /** Tool-registry config — its presentation `mode` (forwarded through agent-spine-demo; see dsh-tools). */
  tools?: ToolsConfig
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** stdin-chat banner printed once on start. Defaults to `'ready.'`. */
  welcome?: string
  /** Skill registry, local-provider, and model-facing consumer config forwarded to agent-spine-demo. */
  skills?: agentCore.SkillConfig
  /** Model-facing bash tool config forwarded through agent-core. */
  toolBash?: NonNullable<agentCore.Config['toolBash']>
  /** Generic background-task control-tool config forwarded through agent-core. */
  toolTasks?: NonNullable<agentCore.Config['toolTasks']>
  /**
   * If set, the pre-created agent RESUMES this persisted session id instead of
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
  toolBash: agentCore.ToolBashConfigSchema,
  toolTasks: agentCore.ToolTasksConfigSchema,
  resumeSessionId: z.string(),
})

/**
 * Compose the spine with the stdio front door. Console logging, persistence,
 * and user interaction mount first; the readline UI then waits on the agent
 * registry and subscribes to config-start failures before agent-core can start
 * the configured identity. The ask-user tool waits on the completed spine.
 * The `hmr` dev-reload plugin is a leaf concern (see the module doc), so it is
 * not mounted here.
 */
export function apply(ctx: Context, config: Config): void {
  const resumeSessionId = config.resumeSessionId === '' ? undefined : config.resumeSessionId
  const sessionId = SessionId(resumeSessionId ?? `main-session-${randomUUID()}`)
  ctx.plugin(ConsoleExporter)
  ctx.plugin(SessionPersistenceJsonl, { root: config.persistenceRoot ?? './.sessions' })
  ctx.plugin(UserInteractionService)
  ctx.plugin(uiStdio, {
    welcome: config.welcome ?? 'ready.',
    sessionId,
  })
  ctx.plugin(agentCore, {
    ...config.persona !== undefined ? { persona: config.persona } : {},
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
    ...config.tools !== undefined ? { tools: config.tools } : {},
    agents: [{
      id: 'main',
      model: config.model,
      cwd: process.cwd(),
      ...resumeSessionId === undefined ? { sessionId } : { resumeSessionId: sessionId },
    }],
    ...config.skills !== undefined ? { skills: config.skills } : {},
    ...config.toolBash !== undefined ? { toolBash: config.toolBash } : {},
    ...config.toolTasks !== undefined ? { toolTasks: config.toolTasks } : {},
  })
  ctx.plugin(toolAskUser)
}
