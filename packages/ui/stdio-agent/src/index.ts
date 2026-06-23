/**
 * The stdio chat app: the providerless agent spine ({@link
 * @deepseek-ai/dsh-agent-core}) plus the coupled front-door cluster a terminal
 * chat needs — a console logger, the readline `ui-stdio` UI, JSONL session
 * persistence, and a pre-created `main` agent the UI drives.
 *
 * The cluster is BAKED IN, not left to the leaf: a stdio app always logs to the
 * console (stdout is just the terminal) and always pre-creates the `main` agent
 * `ui-stdio` sends to. The leaf supplies only the swappable backends (the LLM
 * adapter, the bash executor), the optional `hmr` dev-reload plugin, and this
 * app's {@link Config} (model, prompt, persistence root, welcome banner).
 *
 * `hmr` is deliberately a LEAF entry, not baked in here: it is a Loader-only,
 * subprocess-only dev plugin (its constructor throws without `--expose-internals`
 * + a live `loader`, and the in-process test tier cannot even import it), so a
 * package whose `apply` statically pulled it in could never be unit-tested or
 * carry the per-file coverage gate. Unlike the console logger, a stray `hmr` is
 * not a stdout-purity footgun — so leaving it at the leaf costs no safety, while
 * baking the LOGGER in (the real coupling) keeps stdout-vs-no-stdout a property
 * of the artifact.
 *
 * Counterpart to {@link @deepseek-ai/dsh-acp-agent}, which bakes in the OPPOSITE
 * cluster (no stdout logger, no pre-created agents — the ACP bridge reserves
 * stdout for JSON-RPC and creates agents on demand). Splitting the two front
 * doors into two packages makes each cluster a property of the artifact: there
 * is no logger entry in the ACP leaf to get wrong.
 *
 * Plugin export shape: named `name`/`Config`/`apply`, NO default export — the
 * cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray
 * default would collapse the module to the bare `apply` and drop the `Config`
 * namespace (see docs/postmortem/0001). The keyless Loader-path smoke in the
 * echo example guards this end-to-end.
 *
 * @module @deepseek-ai/dsh-stdio-agent
 */

import type { Context } from 'cordis'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import z from 'schemastery'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as agentCore from '@deepseek-ai/dsh-agent-core'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as uiStdio from '@deepseek-ai/dsh-ui-stdio'

export const name = 'stdio-agent'

/**
 * App config: the swappable per-demo values, each routed to where the app wires
 * it. `model`/`systemPrompt`/`resumeSessionId` configure the pre-created `main`
 * agent (through {@link @deepseek-ai/dsh-agent-core}'s forwarded `agents` list);
 * `persistenceRoot` is the JSONL backend's directory; `welcome` is the UI banner.
 */
export interface Config {
  /** Model name for the `main` agent (must have a registered adapter). */
  model: string
  /** System prompt for the `main` agent. */
  systemPrompt: string
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** stdin-chat banner printed once on start. Defaults to `'ready.'`. */
  welcome?: string
  /**
   * If set, the `main` agent RESUMES this persisted session id instead of
   * starting fresh. Sourced from an env var in the leaf `cordis.yml`
   * (`resumeSessionId: !!js process.env.RESUME_SESSION_ID`).
   */
  resumeSessionId?: string
}

export const Config: z<Config> = z.object({
  model: z.string().required(),
  systemPrompt: z.string().required(),
  persistenceRoot: z.string().default('./.sessions'),
  welcome: z.string().default('ready.'),
  resumeSessionId: z.string(),
})

/**
 * Compose the spine with the stdio front door. The console logger comes first
 * (infra), then the agent-core bundle pre-creating the `main` agent from this
 * app's `model`/`systemPrompt`/`resumeSessionId`, then the JSONL backend, then
 * the `ui-stdio` UI bound to `main`. The `hmr` dev-reload plugin is a leaf
 * concern (see the module doc), so it is not mounted here.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ConsoleExporter)
  ctx.plugin(agentCore, {
    agents: [{
      id: AgentId('main'),
      model: config.model,
      systemPrompt: config.systemPrompt,
      ...config.resumeSessionId !== undefined ? { resumeSessionId: SessionId(config.resumeSessionId) } : {},
    }],
  })
  ctx.plugin(SessionPersistenceJsonl, { root: config.persistenceRoot ?? './.sessions' })
  ctx.plugin(uiStdio, { welcome: config.welcome ?? 'ready.', agent: 'main' })
}
