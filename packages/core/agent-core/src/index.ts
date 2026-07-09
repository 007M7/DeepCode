/**
 * The providerless, executor-less, UI-less agent spine as ONE bundle plugin.
 *
 * Loads the fixed set of services every harness agent needs — `timer`, the LLM
 * service, the session store, system-prompt assembly, the tool registry, the
 * agent registry, the dev-mode invariants, the model-facing `bash` tool
 * schemas, and the concrete `agent-loop` — and forwards the loop's `agents`
 * list as its OWN config (default `[]`), so each app supplies its own
 * pre-created agents.
 *
 * It is deliberately NOT the whole app: the swappable choices stay OUTSIDE the
 * bundle, picked by whatever loads it.
 *  - the LLM ADAPTER (`llm-deepseek`/`llm-pi-ai`/`llm-replay`) — the bundle
 *    ships the abstract `llm` service + `tool-bash` consumer schema; the leaf
 *    registers a concrete adapter on `ctx.llm`.
 *  - the bash EXECUTOR (`bash-local` or a sandboxed impl) — the bundle ships
 *    the `bash` tool consumer; the leaf provides `ctx.bash`.
 *  - the PRESENTATION (stdio UI / ACP bridge / a logger) and the per-app infra
 *    (a console logger, `hmr`) — these are the coupled "front-door cluster" the
 *    app packages ({@link @deepseek-ai/dsh-stdio-agent},
 *    {@link @deepseek-ai/dsh-acp-agent}) bake in, NOT the shared spine.
 *
 * This is the interface/implementation/consumer seam at the composition level:
 * the bundle owns the shared spine, the leaf owns the backends, the app package
 * owns the front door. `timer` is in the spine (common to every front door — it
 * writes nothing to stdout); the console logger is NOT (it writes to stdout,
 * which the ACP bridge reserves for its JSON-RPC channel).
 *
 * Services register in the root store keyed by their isolate symbol, so a child
 * loaded here via `ctx.plugin(...)` is visible to the bundle's SIBLINGS (the
 * leaf's adapter and executor) exactly as a nested `plugin-include` subtree's
 * services were before this bundle existed — cordis gates every read on
 * `inject`, never on load order, so the fixed child set resolves regardless of
 * which entry loads first.
 *
 * Plugin export shape: named `name`/`Config`/`apply`, NO default export — the
 * cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray
 * default would collapse the module to the bare `apply` function and drop the
 * `Config` schema (see docs/postmortem/0001). The keyless Loader-path smokes in
 * the app packages guard this end-to-end.
 *
 * @module @deepseek-ai/dsh-agent-core
 */

import type { Context } from 'cordis'
import Timer from '@cordisjs/plugin-timer'
import z from 'schemastery'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt, { type Config as SystemPromptConfig } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as invariants from '@deepseek-ai/dsh-invariants'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import AgentLoop, { type Config as AgentLoopConfig } from '@deepseek-ai/dsh-agent-loop'

export const name = 'agent-core'

/**
 * Bundle config: each field forwarded verbatim to the child that owns it —
 * `agents` to the agent loop (an app that pre-creates no agents, like the ACP
 * bridge, simply omits it), `persona` and `toolOrder` to the system-prompt
 * plugin (the deployment's persona section and the explicit model-facing tool
 * order), the `tools` object to the tool registry (its presentation `mode`).
 * Every field is optional INPUT here because each owner's schema
 * supplies the default (`[]` / `''` / absent — lexicographic / `native`); the
 * schema is the INTERSECTION of the owners' own schemas (the registry's
 * nested under its `tools` key), so validation and defaulting can never
 * drift from them.
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
}

/** Intersect the owners' schemas so validation + defaulting stay identical (the registry's nested under `tools`). */
export const Config = z.intersect([AgentLoop.Config, SystemPrompt.Config, z.object({ tools: ToolRegistry.Config })]) as unknown as z<Config>

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
  // The forwarded fields are validated + defaulted by this bundle's intersected
  // schema before apply runs, so the ?? fallbacks only narrow the
  // optional-input TYPES — they mirror the owners' schema defaults, never
  // introduce different ones. toolOrder has no owner-supplied default value —
  // ABSENT means "lexicographic order" — so it is forwarded conditionally
  // rather than via ??.
  ctx.plugin(SystemPrompt, {
    persona: config.persona ?? '',
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
  })
  ctx.plugin(ToolRegistry, config.tools ?? {})
  ctx.plugin(AgentRegistry)
  ctx.plugin(invariants)
  ctx.plugin(toolBash)
  ctx.plugin(AgentLoop, { agents: config.agents ?? [] })
}
