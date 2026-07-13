/**
 * The model-facing `subagent` tool: delegate a task to a child agent and return
 * its final output. Pure schema + lifecycle shaping — every transport concern
 * lives behind the `ctx.subagents` provider registry
 * (`@deepseek-ai/dsh-subagent`), so an in-process, ACP, or future A2A backend
 * swaps in without touching what the model sees.
 *
 * Provider selection is config, not model-facing: this plugin is bound to
 * EXACTLY ONE provider name (`Config.provider`). To expose more than one
 * transport, load the plugin more than once, each bound to a different provider
 * — there is no provider/type parameter in the model-facing schema. The model
 * sees only `{ description, prompt }`.
 *
 * The tool DESCRIPTION is derived from the bound provider's conversation-history
 * descriptor ({@link providerWording}): a fresh-conversation provider (spawn,
 * ACP) gets the standalone-prompt wording, while a seeded-conversation provider
 * (fork) tells the model the child already sees the conversation's completed
 * turns. This descriptor says nothing about Cordis scope, services, tools, or
 * authority. The tool MIRRORS the
 * provider's lifecycle via `subagent/provider-added`/`-removed` — it registers
 * when the provider is (or becomes) available and unregisters when the
 * provider goes away — so no load-order requirement exists and an HMR reload
 * of the backend re-derives the wording from the fresh provider.
 *
 * Collection is SYNCHRONOUS this cut: `execute` starts a run and awaits
 * `run.result` inside a `try/finally` that always disposes the run, so the
 * owned child agent/session is torn down on every path (success, error, abort)
 * and never leaks as a live idle child. A non-`completed` stop reason maps to an
 * `isError` tool result (by throwing) rather than returning partial output as
 * success.
 *
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents']

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * The model-facing tool name to register (default `subagent`). To expose more
   * than one transport, load this plugin once per provider — each load MUST set
   * a distinct `toolName` (the tool registry rejects a duplicate name), e.g.
   * `{ provider: 'spawn', toolName: 'subagent' }` and
   * `{ provider: 'acp', toolName: 'subagent_acp' }`.
   */
  toolName?: string
  /**
   * Default per-child agent options (model) applied to every spawned child.
   * Omitted fields fall back to the child loop's own defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona applied to every child this tool spawns: a scoped
   * `deployment:persona` section shadowing the deployment's persona for the
   * child alone. Requires the bound provider's `persona` capability
   * (in-process backends support it; a request against one that doesn't is
   * rejected at start). Omitted ⇒ the child renders the deployment persona.
   */
  persona?: string
  /**
   * Tool scoping applied to every child this tool spawns (see
   * `SubagentStartRequest.toolFilter`): the named global tools vanish from
   * the child's prompt AND refuse to execute. Requires the provider's
   * `toolFilter` capability. Unknown names fail the spawn loudly. Note the
   * child otherwise sees every global tool — including this delegation tool
   * itself; `deny`-listing it (or setting `maxDepth`) is how a deployment
   * bounds recursion.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Recursion cap applied to every child this tool spawns (see
   * `SubagentStartRequest.maxDepth`): a spawn whose child would sit deeper
   * than this in the delegation tree is rejected. Requires the provider's
   * `depthLimit` capability. Must be a non-negative safe integer and is
   * validated when the plugin loads. Omitted ⇒ unbounded (bound it in
   * deployments that expose this tool to children).
   */
  maxDepth?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  // Omitted-object discipline (see the toolFilter note below): without the
  // forced default an omitted `agentOptions` materializes `{}`, which reads as
  // present — the request would carry `agentOptions: {}` and the presence
  // check in execute() could never be false through config.
  agentOptions: z.object({
    model: z.string(),
  }).default(undefined as unknown as { model: string }),
  persona: z.string(),
  // A schemastery object materializes {} (with [] for nested arrays) when the
  // key is omitted — for toolFilter that would mean an EMPTY ALLOW-LIST, i.e.
  // deny-everything, silently. Force the omitted key to stay absent (the same
  // shape discipline as SystemPrompt's toolOrder); the cast is needed because
  // .default() expects the object type.
  // The NESTED arrays get the same treatment as the object itself: a partial
  // filter ({deny: […]}) must not materialize allow: [] beside it — an empty
  // allow-list means deny-EVERYTHING, so the materialized default would turn
  // a deny-one config into deny-all. An EXPLICIT allow: [] (grant-only
  // children) survives, since only the omitted key defaults to undefined.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
})

/**
 * Flatten a child's final output blocks to text for the tool result. The child
 * may return non-text blocks; this cut surfaces the text content (the common
 * case) and drops the rest, which is acceptable for a synchronous summary —
 * the structured path (`outputSchema`) is the channel for non-text results.
 */
function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork. Exported for tests.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
export function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that INHERITS this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn), returning only its final '
        + 'result. Use this when the subtask builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive only its final answer, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'and return its final result. Use this to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'runs to completion and you receive only its final answer, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

export function apply(ctx: Context, config: Config): void {
  // Keep misconfiguration at plugin load even when a caller invokes apply()
  // directly and bypasses Schemastery's natural/max metadata.
  assertSubagentMaxDepth(config.maxDepth)
  // Misconfiguration fails loud AT LOAD (the check is self-contained): an
  // explicit `toolFilter: {}` would otherwise pass the capability gate and
  // kill every delegation later, in the child-setup `restrict({})` throw.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  // The tool MIRRORS its provider's lifecycle instead of assuming load order:
  // the cordis Loader starts sibling entries concurrently, so "backend listed
  // first in cordis.yml" does not guarantee "provider registered first", and
  // an HMR reload of the backend replaces the provider while this fiber stays
  // loaded. Register the tool when the bound provider is (or becomes)
  // available — deriving the wording from THAT provider — and unregister it
  // when the provider goes away, so the description can never outlive or
  // predate the provider it describes.
  let disposeTool: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    const wording = providerWording(provider.inheritsParentContext)
    disposeTool = ctx.tools.register(defineTool({
      name: config.toolName ?? 'subagent',
      description: wording.description,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
      },
      async execute(args, exec): Promise<ContentBlock[]> {
        const parent = exec.agent
        if (!parent) {
          // The loop sets `exec.agent` for every model-driven call; its absence
          // means a non-agent caller invoked the tool directly, which has no
          // parent to attribute the child to. Fail loud rather than guess.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        const request: SubagentStartRequest = {
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          signal: exec.signal ?? new AbortController().signal,
          ...config.agentOptions !== undefined ? { agentOptions: config.agentOptions } : {},
          ...config.persona !== undefined ? { persona: config.persona } : {},
          ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
          ...config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {},
        }

        const run: SubagentRun = await ctx.subagents.start(config.provider, request)

        try {
          const result = await run.result
          const error = stopReasonError(result)
          if (error !== undefined) {
            // Map a non-clean finish to an isError result (the registry turns a
            // throw into an isError). Report the reason, not partial output.
            throw new Error(error)
          }
          return [{ type: 'text', text: outputText(result.output) }]
        } finally {
          // Always reach child quiescence — never leak a live idle child/session.
          await run.dispose()
        }
      },
    }))
  }

  // Listeners first, then the presence check: both run synchronously, so no
  // registration can slip between them; the `disposeTool === undefined` guard
  // makes a same-tick added-event after a successful mount a no-op.
  // TODO(subagent-dup-toolname): two WAITING fibers configured with the same
  // toolName collide only when their provider finally arrives — the duplicate
  // tool-name throw then propagates through `subagent/provider-added` and
  // rolls back the PROVIDER registration, so an invalid config blasts the
  // backend's fiber instead of the misconfigured tool's. Config-time detection
  // would need a cross-fiber registry of intended tool names; revisit if a
  // real deployment ever hits it.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // Not an error: the backend's fiber may simply activate after this one.
    // The tool appears the moment the provider registers; a typo'd provider
    // name shows up as this note plus a tool that never materializes.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
}
