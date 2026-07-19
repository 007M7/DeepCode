/**
 * The stdio chat app: the default agent spine ({@link @deepseek-ai/dsh-agent-spine-demo}) plus the
 * coupled front-door cluster a terminal chat needs — TTY-selected pi-tui/readline
 * presentation, JSONL session persistence, the user-interaction seam with its
 * `ask_user_question` tool, and one pre-created agent whose exact shared
 * agent/session identity the selected UI drives under its `main` display label.
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
import * as workspaceContext from '@deepseek-ai/dsh-workspace-context'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as uiStdio from '@deepseek-ai/dsh-stdio'
import * as uiTui from '@deepseek-ai/dsh-tui'

export const name = 'stdio-demo'
const DEFAULT_PERSISTENCE_ROOT = './.sessions'
const DEFAULT_WELCOME = 'ready.'

/** Terminal front door selected by the app bundle. */
export type TerminalMode = 'auto' | 'readline' | 'tui'

/** App-level terminal selection with nested TUI presentation settings. */
export interface UiConfig {
  /** Select a concrete front door or infer it from the process streams. */
  mode?: TerminalMode
  /** Settings forwarded only when the pi-tui front door is selected. */
  tui?: uiTui.TuiConfig
}

const terminalModeSchema = z.union(['auto', 'readline', 'tui'] as const).default('auto')

/** Schemastery schema for app-level terminal selection. */
export const UiConfigSchema: z<UiConfig> = z.object({
  mode: terminalModeSchema,
  tui: uiTui.TuiConfigSchema,
})

/**
 * Resolve the app's terminal front door.
 * @param config - app-level terminal selection.
 * @param isTTY - whether both process streams are interactive TTYs.
 * @returns the concrete UI package to mount.
 */
export function resolveTerminalMode(config: UiConfig | undefined, isTTY: boolean): Exclude<TerminalMode, 'auto'> {
  const mode = config?.mode ?? 'auto'
  if (mode === 'auto') return isTTY ? 'tui' : 'readline'
  if (mode === 'tui' && !isTTY) {
    throw new Error('stdio-demo: TUI mode requires both stdin and stdout to be TTYs; use mode "readline" for pipes')
  }
  return mode
}

/**
 * App config: the swappable per-demo values, each routed to where the app wires
 * it. `provider`/`model`/`resumeSessionId` configure the pre-created `main` agent (through
 * {@link @deepseek-ai/dsh-agent-spine-demo}'s forwarded `agents` list); `persona` is
 * the deployment persona (forwarded to the system-prompt plugin); `toolOrder`
 * is the explicit model-facing tool order (forwarded to the system-prompt plugin);
 * fresh sessions use `process.cwd()` as their workspace cwd; resumed sessions
 * keep their persisted cwd. `persistenceRoot` is the JSONL backend's directory;
 * `welcome` is the UI banner and `ui` configures terminal mode/presentation.
 */
export interface Config {
  /** Provider route for the `main` agent. */
  provider: string
  /** Model name for the `main` agent (must have a registered adapter). */
  model: string
  /** Bundled agent-loop concurrency cap; `1` is serial and omission uses its default. */
  maxParallelToolCalls?: number
  /** Deployment persona (the system-prompt plugin's `persona` config). */
  persona?: string
  /** Explicit model-facing tool order (the system-prompt plugin's `toolOrder` config; see dsh-system-prompt). */
  toolOrder?: string[]
  /** Tool-registry config — its presentation `mode` (forwarded through agent-spine-demo; see dsh-tools). */
  tools?: ToolsConfig
  /** DeepSeek Harness home directory exposed to bash and used for local skill discovery. */
  dshHome?: string
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** stdin-chat banner printed once on start. Defaults to `'ready.'`. */
  welcome?: string
  /** Terminal front-door selection and pi-tui presentation settings. */
  ui?: UiConfig
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
  /** Controls automatic AGENTS.md/CLAUDE.md loading; configure a byte budget or set `false`. */
  workspaceContext: agentCore.Config['workspaceContext']
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  maxParallelToolCalls: z.number().step(1).min(1),
  persona: z.string(),
  // The array default is forced to undefined: ABSENT means "lexicographic
  // order" (the owning dsh-system-prompt schema does the same), while
  // schemastery's native [] default would read as an invalid configured list.
  toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  tools: ToolRegistry.Config,
  dshHome: z.string(),
  persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
  welcome: z.string().default(DEFAULT_WELCOME),
  ui: UiConfigSchema,
  skills: agentCore.SkillConfigSchema,
  toolBash: agentCore.ToolBashConfigSchema,
  toolTasks: agentCore.ToolTasksConfigSchema,
  resumeSessionId: z.string(),
  workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
})

/**
 * Compose the spine with one terminal front door. Persistence and user
 * interaction mount first; the selected UI then waits on the exact session id
 * and subscribes to config-start failures before agent-core starts it. Console
 * logging is readline-only because fullscreen output belongs to pi-tui. The
 * ask-user tool waits on the completed spine, and HMR remains a leaf concern.
 * @param ctx - context receiving the app's child plugins.
 * @param config - app configuration routed to the spine and front door.
 * @param isTTY - whether both process streams are interactive TTYs.
 */
export function composeTerminalApp(ctx: Context, config: Config, isTTY: boolean): void {
  const resumeSessionId = config.resumeSessionId === '' ? undefined : config.resumeSessionId
  const sessionId = SessionId(resumeSessionId ?? `main-session-${randomUUID()}`)
  const mode = resolveTerminalMode(config.ui, isTTY)
  if (mode === 'readline') ctx.plugin(ConsoleExporter)
  ctx.plugin(SessionPersistenceJsonl, { root: config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT })
  ctx.plugin(UserInteractionService)
  if (mode === 'tui') {
    ctx.plugin(uiTui, {
      ...config.ui?.tui,
      welcome: config.welcome ?? DEFAULT_WELCOME,
      sessionId,
    })
  } else {
    ctx.plugin(uiStdio, {
      welcome: config.welcome ?? DEFAULT_WELCOME,
      sessionId,
    })
  }
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

/** Compose the configured terminal front door with the agent app. */
/* v8 ignore start -- production stream capability wiring; composeTerminalApp is unit-covered,
   and the coding-agent PTY smoke covers the interactive process path */
export function apply(ctx: Context, config: Config): void {
  composeTerminalApp(ctx, config, process.stdin.isTTY && process.stdout.isTTY)
}
/* v8 ignore stop */
