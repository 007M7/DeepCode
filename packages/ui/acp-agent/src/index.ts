/**
 * The ACP server app: the providerless agent spine ({@link
 * @deepseek-ai/dsh-agent-core}) plus the coupled front-door cluster an ACP
 * server needs — JSONL session persistence and the {@link @deepseek-ai/dsh-acp}
 * bridge, and DELIBERATELY NOTHING that writes to stdout.
 *
 * The cluster is the OPPOSITE of {@link @deepseek-ai/dsh-stdio-agent}'s, and
 * baking it in is the whole point: an ACP server speaks JSON-RPC on stdout, so
 * a stray console logger would corrupt the protocol frames (the [stdout-purity
 * footgun]). This package contains NO console-logger entry, NO `hmr` (the editor
 * owns the subprocess), and pre-creates NO agents (ACP `session/new` creates
 * them on demand) — so the default front door has no logger entry to get wrong.
 * (A leaf `cordis.yml` could still add a sibling `@cordisjs/plugin-logger-console`,
 * which this app does not prevent — so the rule "never add a stdout logger to an
 * ACP leaf" still stands; the app just gives the leaf nothing to misconfigure.)
 *
 * The leaf supplies the swappable backends: the LLM adapter (`llm-deepseek` for
 * the real model, `llm-replay` for keyless snapshot replay), the bash executor
 * (`bash-local`), and any optional product tools it wants to expose. This app's
 * {@link Config} (model, system prompt, persistence root) routes each value to
 * where it is wired — model/prompt onto the bridge's per-session agent
 * template, the root onto the JSONL backend.
 *
 * Plugin export shape: named `name`/`Config`/`apply`, NO default export — the
 * cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray
 * default would collapse the module to the bare `apply` and drop the `Config`
 * namespace (see docs/postmortem/0001 — the exact bug that shipped here once).
 * The keyless ACP snapshot/Loader-path tests guard this end-to-end.
 *
 * @module @deepseek-ai/dsh-acp-agent
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import * as acp from '@deepseek-ai/dsh-acp'
import * as agentCore from '@deepseek-ai/dsh-agent-core'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

export const name = 'acp-agent'

/**
 * App config: the swappable per-deployment values. `model`/`systemPrompt`
 * configure the agent template the ACP bridge creates each session's agent from
 * (NOT a pre-created agent — ACP creates agents at `session/new`);
 * `persistenceRoot` is the JSONL backend's directory.
 */
export interface Config {
  /** Model name for ACP-created agents (must have a registered adapter). */
  model: string
  /** Per-agent system prompt for ACP-created agents. */
  systemPrompt: string
  /** Directory the JSONL session backend writes under. Defaults to `./.sessions`. */
  persistenceRoot?: string
}

export const Config: z<Config> = z.object({
  model: z.string().required(),
  systemPrompt: z.string().required(),
  persistenceRoot: z.string().default('./.sessions'),
})

/**
 * Compose the spine with the ACP front door. The agent-core bundle pre-creates
 * NO agents (its `agents` list defaults to `[]`); the JSONL backend persists
 * under `persistenceRoot`; the ACP bridge owns stdout for JSON-RPC and creates
 * one agent per `session/new` from `model`/`systemPrompt`. No logger, no `hmr` —
 * stdout stays pure.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(agentCore)
  ctx.plugin(SessionPersistenceJsonl, { root: config.persistenceRoot ?? './.sessions' })
  ctx.plugin(acp, { model: config.model, systemPrompt: config.systemPrompt })
}
