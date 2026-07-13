/**
 * System prompt assembly registry. Plugins contribute ordered text sections,
 * tool schema providers, and named prompt variables; `assemble(context)`
 * collates them through a waterfall that runs once per step, and `renderPrompt`
 * interpolates `{{variable}}` references into the final text.
 *
 * The harness-owned prompt openers live here too: this plugin registers the
 * static `harness:identity` section (order −100) and the deployment's
 * `deployment:persona` section (order 0, from its `persona` config), so they
 * exist for every agent regardless of which loop plugin drives it.
 *
 * @module @deepseek-ai/dsh-system-prompt
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, Scoped } from '@deepseek-ai/dsh-scope'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

declare module 'cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }

  interface Events {
    /**
     * Waterfall around prompt assembly — mutate or extend the
     * {@link PromptAssembly} (sections + tools + variables) before it is
     * rendered. Bound to the {@link SystemPrompt} service; call `next()` to
     * delegate.
     *
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is keyed
     * by `context.scope` — a listener registered through `agent.ctx` fires only
     * for that agent's assemblies; a plain plugin listener fires for every
     * assembly (scope-less ones included, dispatched subject-less).
     *
     * The returned assembly is authoritative. This is an expert composition
     * seam: a listener that removes or replaces another plugin's protocol
     * contribution owns preserving that protocol's invariants.
     * @param assembly - the assembly built from the registered sections, tool
     *   providers, and variable providers; listeners may mutate it or return a
     *   replacement.
     * @param context - the per-assembly {@link AssembleContext} the caller
     *   passed to {@link SystemPrompt.assemble} (e.g. which agent the prompt
     *   is for), so a listener can filter or extend per agent.
     * @mode waterfall
     */
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * A section, tool provider, or variable provider was registered
     * or unregistered (the assembly inputs changed — possibly for one scope
     * only). An UNFILTERED registry-subject notification, deliberately not
     * scope-filtered dispatch: a global change concerns every agent's next
     * assembly, so a scoped listener subscribing here sees every change, not
     * just its own scope's.
     * @mode emit
     */
    'system-prompt/change'(): void
  }
}

/**
 * Per-assembly input: what one {@link SystemPrompt.assemble} call is FOR.
 * Merge-extensible and agnostic of who assembles — `@deepseek-ai/dsh-agent`
 * declares the `agent` field, so section text and variable providers can be
 * functions of the calling agent. Every field is optional by nature: a bare
 * `assemble()` (tests, diagnostics) carries an empty, scope-less context, and
 * providers must tolerate absent fields.
 */
export interface AssembleContext {
  /**
   * The scope layer this assembly resolves (`@deepseek-ai/dsh-scope`): scoped
   * sections/variables/tool-providers registered through this key's context
   * join the assembly (shadowing same-named global contributions), and the
   * `system-prompt/assemble` waterfall dispatches in this scope. The agent
   * loop sets it to the agent (alongside the `agent` DX field — never set
   * `agent` without `scope`; the dev invariants flag the mismatch). Absent =
   * a scope-less assembly: global layer only, subject-less dispatch.
   */
  scope?: ScopeKey
}

/** One contributed section of the system prompt (registry input). */
export interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Convention: `-100` is the
   * harness identity, `0` the deployment persona, tool guidance uses 100–199;
   * other negative orders also render before the persona.
   */
  readonly order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}.
   */
  readonly text: string | ((context: AssembleContext) => string)
}

/** One section of an assembly: {@link PromptSection} with its text resolved. */
export interface AssembledSection {
  /** The contributing section's unique name. */
  name: string
  /** The contributing section's order (sections arrive sorted ascending). */
  order: number
  /** The resolved (but not yet interpolated) section text. */
  text: string
}

/**
 * What one tool-schema provider contributes to an assembly
 * ({@link SystemPrompt.tools}). `schemas` is the provider's POST-restriction
 * visible set for the assembly's scope — exactly what the model may be shown.
 * `knownNames` is its PRE-restriction name universe: the set configured names
 * (`toolOrder`) are validated against, so a config typo fails loud while a
 * restricted-away tool stays a normal, non-erroneous absence. Omitted,
 * `knownNames` defaults to the names of `schemas` (right for providers with no
 * restriction concept).
 */
export interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}

/**
 * The assembled prompt.
 *
 * Tool schemas are part of the assembly by design: "what the model is told it
 * can do" is one coherent thing managed here, even though adapters transmit
 * `tools` as a separate wire field rather than prompt text. They arrive in
 * the canonical model-facing order (see {@link Config.toolOrder}).
 *
 * `variables` carries every registered prompt variable resolved against this
 * assembly's context — key present means registered, `undefined` value means
 * "no value for this assembly" (referencing it renders an error). Section
 * texts are resolved but NOT yet interpolated; {@link renderPrompt} applies
 * the variables, so waterfall listeners can still add sections or variables.
 *
 * Merge-extensible: plugins can declare extra fields on this interface.
 */
export interface PromptAssembly {
  sections: AssembledSection[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}

/** Valid variable names: how they are written between the braces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** A complete `{{...}}` reference group at the scan position (validated after). */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/**
 * The rest entry for {@link Config.toolOrder}: the position where registered
 * tools not named in the list are inserted (in lexicographic name order).
 * Reserved: collected tool schemas using this name are rejected before
 * ordering, so the marker can never collide with a real model-facing tool.
 */
export const TOOL_ORDER_REST = '<unlisted-tools>'

/**
 * Validate a configured tool-order list's shape at service construction:
 * the {@link TOOL_ORDER_REST} rest entry exactly once, no duplicate names.
 * Returns the list (or undefined when unconfigured); throws otherwise,
 * failing the service at load — a bad order config must never reach an
 * assembly. Whether every listed name matches a registered tool is checked
 * at each assembly instead ({@link orderTools}): tool plugins register after
 * this service constructs, so the tool set does not exist yet here.
 */
function validateToolOrder(toolOrder: string[] | undefined): string[] | undefined {
  if (toolOrder === undefined) return undefined
  const seen = new Set<string>()
  for (const name of toolOrder) {
    if (seen.has(name)) throw new Error(`toolOrder lists "${name}" more than once`)
    seen.add(name)
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    throw new Error(`toolOrder must contain the "${TOOL_ORDER_REST}" rest entry (where unlisted tools are inserted)`)
  }
  return toolOrder
}

/**
 * Order collected tool schemas by the validated policy: with no configured
 * list, plain lexicographic name order; with one, listed names take their
 * listed position and every unlisted tool lands at the
 * {@link TOOL_ORDER_REST} rest entry in lexicographic name order. A listed
 * name outside `knownNames` — the providers' PRE-restriction name universe —
 * throws: misconfiguration fails loud, and each assembly is the earliest
 * moment the registered tool set exists to check against (tool plugins
 * register after the service constructs, so load time is too early); the
 * assembly rejects, failing the caller's turn before any model request. A
 * listed name that is KNOWN but not collected (a tool restricted away for
 * this assembly's scope) is a normal absence: its position simply
 * contributes nothing — `toolOrder` stays compatible with per-agent
 * `restrict()` masks. Never drops a collected tool, and both sorts are
 * stable, so tools sharing a name keep their collection order.
 */
function orderTools(tools: ToolSchema[], toolOrder: string[] | undefined, knownNames: ReadonlySet<string>): ToolSchema[] {
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`)
  }
  if (toolOrder === undefined) return tools.sort(compareToolNames)
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`)
  }
  const listed = new Set(toolOrder)
  const rest = tools.filter(tool => !listed.has(tool.name)).sort(compareToolNames)
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name))
}

/** Lexicographic (code-unit) name comparison — locale-independent, so the order is identical on every machine. */
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.persona} for its contract). */
export interface Config {
  /**
   * The deployment's persona — the ONE deployment-authored fragment of the
   * system prompt, rendered as the order-0 `deployment:persona` section
   * (after the harness identity, before all tool guidance). Every agent in
   * the context shares it by default; a per-agent persona is a SCOPED section
   * of the same name registered through that agent's `agent.ctx` (it shadows
   * this one for that agent — the subagent seam's `persona` request field does
   * exactly that). Template, not free-form text:
   * every complete `{{…}}` group is interpreted strictly against the
   * registered prompt variables (the shipped agent loop registers `{{model}}`
   * and `{{cwd}}`), and there is no escape syntax for literal `{{…}}` prose
   * yet (a deliberate deferral; see the prompt-variables RFC). Defaults to
   * `''` — the empty section is dropped at render, so a persona-less
   * deployment opens with the harness identity alone.
   */
  persona?: string
  /**
   * Explicit model-facing tool order, as a list of `ToolSchema.name`s: listed
   * tools take their listed position, and tools absent from the list are
   * inserted at the {@link TOOL_ORDER_REST} (`'<unlisted-tools>'`) entry in
   * lexicographic name order. A configured list must contain the rest entry
   * exactly once, no duplicate names, and no name without a registered tool —
   * a misconfigured order blocks work instead of silently reaching a model
   * request: shape violations throw at load, and an unregistered name rejects
   * every assembly. `TOOL_ORDER_REST` is reserved for the list marker and may
   * not be a collected tool name; such a provider output also rejects the
   * assembly. The single assembly-time validation rejects either failure
   * before any model request — the earliest moment the registered tool set
   * exists to check against, since tool plugins register after this service
   * constructs. When omitted, tools are ordered lexicographically by name.
   * Applied to the tools
   * {@link SystemPrompt.assemble} collects, BEFORE the
   * `system-prompt/assemble` waterfall — like the sections' `order` sort, it
   * canonicalizes what the registry contributed (registration order is a
   * plugin-load artifact); a waterfall listener that mutates the tool list
   * owns the determinism of what it emits. Rationale (and why not per-plugin
   * weights): docs/rfc/implemented/feature/2026-07-06-explicit-tool-order.md.
   */
  toolOrder?: string[]
}

/**
 * Renders the text part of an assembly: interpolates `{{variable}}`
 * references in each section from `assembly.variables`, drops empty sections,
 * and joins the rest with blank lines.
 *
 * Strict by design (fail loud beats shipping a malformed prompt): a reference
 * to an unregistered variable, to a registered variable with no value for
 * this assembly, a complete `{{…}}` group that is not a well-formed variable
 * name (e.g. `{{ model }}`), or a `{{` that does not open a complete group
 * while a `}}` still follows (e.g. `{{{model}}}`, `{{a{b}}`) all throw. A
 * lone `{{` with no `}}` anywhere after it is ordinary prose and passes
 * through verbatim. Substituted values are never re-scanned.
 * @param assembly - the assembly to render (typically the awaited result of
 *   {@link SystemPrompt.assemble}); only `sections` and `variables` are read.
 * @returns the full system prompt text; `''` when every section renders empty
 *   (the caller then sends no system prompt at all).
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section, assembly.variables))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/** Interpolate one section's `{{variable}}` references (see {@link renderPrompt}). */
function interpolate(section: AssembledSection, variables: Record<string, string | undefined>): string {
  const text = section.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // No complete simple group starts at this `{{`. A `}}` further on means
      // a mangled reference (extra or nested braces) — fail loud. With no
      // closing `}}` anywhere after, it is ordinary prose (shell, JSON) and
      // passes through verbatim.
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in section "${section.name}" (references are complete simple {{name}} groups)`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // group[0] is the whole `{{...}}` match (a plain string, no optional
    // index): the name is its interior. `{{}}` yields '' → the malformed path.
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in section "${section.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // Object.hasOwn, NOT `in`: `in` walks the prototype chain, so an
    // unregistered `{{constructor}}` would resolve to Object.prototype's and
    // splice a function's source text into the prompt instead of throwing.
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in section "${section.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (section "${section.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/**
 * Registry service (`ctx.systemPrompt`): plugins contribute ordered text
 * sections, tool-schema providers, and named prompt variables; the agent loop
 * calls `assemble(context)` once per step. Registers the harness-owned
 * `harness:identity` and `deployment:persona` sections itself (see
 * {@link Config.persona}).
 */
export class SystemPrompt extends Service {
  static Config: z<Config> = z.object({
    persona: z.string().default(''),
    // A schemastery array defaults to [] when omitted, but an omitted
    // toolOrder must stay absent ("lexicographic order"), not become an
    // explicitly-configured empty list (which is invalid — it lacks the
    // rest entry). Forcing the default to undefined keeps the key out of the
    // validated config; the cast is needed because .default() expects the
    // array type.
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private sections: PromptSection[] = []
  private toolProviders: ((context: AssembleContext) => ToolProviderResult)[] = []
  private variableProviders = new Map<string, (context: AssembleContext) => string | undefined>()
  /** Per-scope layers (`@deepseek-ai/dsh-scope`); entries drop when a layer empties, so a disposed scope leaves no residue. */
  private scopedSections = new Map<ScopeKey, PromptSection[]>()
  private scopedToolProviders = new Map<ScopeKey, ((context: AssembleContext) => ToolProviderResult)[]>()
  private scopedVariableProviders = new Map<ScopeKey, Map<string, (context: AssembleContext) => string | undefined>>()
  private readonly toolOrder: string[] | undefined

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // The harness-owned openers. They live HERE (not on the loop plugin) so a
    // deployment that swaps in a different loop keeps them: the identity is a
    // harness fact stated ahead of everything, and the persona is the
    // deployment's config, one section of the full prompt, never the whole.
    // An empty persona still RESERVES the section name (one owner — a plugin
    // re-registering it throws); renderPrompt drops the empty text.
    this.section({
      name: 'harness:identity',
      order: -100,
      text: 'You are an AI agent powered by the DeepSeek Harness SDK.',
    })
    this.section({
      name: 'deployment:persona',
      order: 0,
      // The schema already defaulted an omitted persona to ''; the ?? only
      // narrows the optional-input TYPE, it never supplies a different value.
      text: config.persona ?? '',
    })
  }

  /**
   * Contribute a text section to the system prompt. Order is determined by
   * `section.order` (ascending). The layer is decided by the CALLING context
   * (`@deepseek-ai/dsh-scope`): a plain plugin context contributes globally; a
   * scoped context (`agent.ctx`) contributes to that scope alone — and a
   * scoped section SHADOWS a same-named global section for that scope's
   * assemblies (most-specific-wins; this is how a per-agent persona overrides
   * `deployment:persona`). The readonly typed contribution is borrowed until
   * disposal; only the semantic
   * finite-order rule is checked at runtime. Throws if the SAME layer already has the name (a
   * duplicate would silently double prompt text — e.g. a double-loaded tool
   * plugin; the global-duplicate message names `agent.ctx` as the per-agent
   * alternative). Removed when the calling fiber is disposed. Emits
   * `system-prompt/change` on register/unregister.
   * @param section - the section to contribute (name, order, text or provider).
   * @returns the disposer that removes the section. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    const scope = scopeOf(this.ctx)
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      const layer = scope === undefined
        ? this.sections
        : this.scopedSections.get(scope) ?? (() => {
          const created: PromptSection[] = []
          this.scopedSections.set(scope, created)
          return created
        })()
      if (layer.some(existing => existing.name === section.name)) {
        throw new Error(scope === undefined
          ? `prompt section "${section.name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
          : `prompt section "${section.name}" is already registered in this scope`)
      }
      layer.push(section)
      // Yield the rollback BEFORE emitting `system-prompt/change`: a generator
      // effect collects each yielded disposer before the next step runs, so a
      // throwing change listener removes the section instead of leaking it into
      // every future assembly.
      yield () => {
        const index = layer.indexOf(section)
        /* v8 ignore next 3 -- defensive: section was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) layer.splice(index, 1)
        if (scope !== undefined && layer.length === 0) this.scopedSections.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.section()')
    // The EXACT cordis effect disposer, not a wrapper: a composite (generator)
    // effect that owns a teardown ORDER must be able to yield THIS function —
    // cordis nests a disposer out of the fiber's concurrent sibling list by
    // exact function identity, so a wrapper would silently break the nesting
    // (the agents.register() lesson). Cleanup is synchronous because this
    // registration installs only synchronous state and notifications.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Contribute a tool-schema provider, evaluated at each assembly call with
   * that assembly's {@link AssembleContext} (so it reflects the live registry
   * state AND the assembly's scope — see {@link ToolProviderResult} for the
   * `schemas`/`knownNames` split). The layer is decided by the calling
   * context: a scoped provider (registered through `agent.ctx`) is consulted
   * only for that scope's assemblies. Removed when the calling fiber is
   * disposed. A provider must not return a schema named
   * {@link TOOL_ORDER_REST}; that name is reserved for
   * {@link Config.toolOrder}'s rest entry and rejects the assembly. Emits
   * `system-prompt/change`.
   * @param provider - evaluated at every {@link assemble} for fresh schemas.
   * @returns the disposer that removes the provider. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    const scope = scopeOf(this.ctx)
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      const layer = scope === undefined
        ? this.toolProviders
        : this.scopedToolProviders.get(scope) ?? (() => {
          const created: ((context: AssembleContext) => ToolProviderResult)[] = []
          this.scopedToolProviders.set(scope, created)
          return created
        })()
      layer.push(provider)
      // Yield the rollback BEFORE emitting `system-prompt/change` (see section()).
      yield () => {
        const index = layer.indexOf(provider)
        /* v8 ignore next 3 -- defensive: provider was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) layer.splice(index, 1)
        if (scope !== undefined && layer.length === 0) this.scopedToolProviders.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.tools()')
    // The EXACT cordis effect disposer, not a wrapper: a composite (generator)
    // effect that owns a teardown ORDER must be able to yield THIS function —
    // cordis nests a disposer out of the fiber's concurrent sibling list by
    // exact function identity, so a wrapper would silently break the nesting
    // (the agents.register() lesson). Cleanup is synchronous because this
    // registration installs only synchronous state and notifications.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Contribute a named prompt variable, referenced from section text as
   * `{{name}}`. The provider is evaluated at each assembly with that
   * assembly's {@link AssembleContext}; returning `undefined` means "no value
   * for this assembly" (a section referencing it then fails to render — a
   * deployment must not claim facts it does not have). The layer is decided
   * by the calling context: a scoped variable (registered through
   * `agent.ctx`) resolves only for that scope's assemblies and SHADOWS a
   * same-named global variable there. Throws on a name that does not match
   * `[a-z][a-z0-9_]*` (it could never be referenced) or one already registered
   * in the SAME layer. Removed when the calling fiber is disposed; emits
   * `system-prompt/change` on register/unregister.
   * @param name - the reference name (matches `[a-z][a-z0-9_]*`).
   * @param provider - evaluated at every {@link assemble} for the value.
   * @returns the disposer that removes the variable. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    const scope = scopeOf(this.ctx)
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      const layer = scope === undefined
        ? this.variableProviders
        : this.scopedVariableProviders.get(scope) ?? (() => {
          const created = new Map<string, (context: AssembleContext) => string | undefined>()
          this.scopedVariableProviders.set(scope, created)
          return created
        })()
      if (layer.has(name)) {
        throw new Error(scope === undefined
          ? `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)`
          : `prompt variable "${name}" is already registered in this scope`)
      }
      layer.set(name, provider)
      // Yield the rollback BEFORE emitting `system-prompt/change` (see section()).
      yield () => {
        layer.delete(name)
        if (scope !== undefined && layer.size === 0) this.scopedVariableProviders.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.variable()')
    // The EXACT cordis effect disposer, not a wrapper: a composite (generator)
    // effect that owns a teardown ORDER must be able to yield THIS function —
    // cordis nests a disposer out of the fiber's concurrent sibling list by
    // exact function identity, so a wrapper would silently break the nesting
    // (the agents.register() lesson). Cleanup is synchronous because this
    // registration installs only synchronous state and notifications.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Assemble the current prompt for one caller: the global layer merged with
   * {@link AssembleContext.scope}'s layer (scoped sections/variables SHADOW
   * same-named global ones — most-specific-wins) — section texts resolved
   * against `context` and sorted by order across the union, tools collected
   * from the global providers plus the scope's and put in the canonical
   * model-facing order ({@link Config.toolOrder}, or lexicographic name order
   * when unconfigured — provider registration order is a plugin-load artifact
   * and never reaches the assembly; a configured order naming a tool outside
   * the providers' `knownNames` universe rejects the assembly, while a known
   * name restricted away for this scope is a normal absence), and every
   * visible variable resolved against `context` into `assembly.variables`.
   * Tool schemas are detached because assembly waterfalls may mutate them.
   * Runs through the `system-prompt/assemble` waterfall, giving listeners the
   * opportunity to mutate or replace the assembly; the returned value is the
   * authoritative model-visible composition. Like the sections' `order`
   * sort, tool canonicalization happens on the initial assembly; listener
   * output owns its own determinism. Await the result before reading the
   * assembly values — waterfall listeners may be async.
   * Interpolation happens later, in {@link renderPrompt}.
   * @param context - what this assembly is for (defaults to an empty context;
   *   see {@link AssembleContext}).
   * @returns the assembly after the waterfall has run.
   */
  // async so the misconfigured-toolOrder throw in orderTools surfaces as a
  // rejection: a Promise-returning method must not throw synchronously
  // (`assemble().catch(...)` would miss it).
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const scope = context.scope
    // Variables: global layer first, then the scope's layer OVERWRITES
    // same-named entries (shadowing — a per-agent value wins for that agent).
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variableProviders) {
      variables[name] = provider(context)
    }
    const scopedVariables = scope === undefined ? undefined : this.scopedVariableProviders.get(scope)
    for (const [name, provider] of scopedVariables ?? []) {
      variables[name] = provider(context)
    }
    // Sections: merge by name, scoped REPLACING same-named global entries
    // (most-specific-wins — the per-agent persona mechanism), then sort by
    // order across the union. Registration order within a layer is preserved
    // for equal orders (stable sort).
    const sectionByName = new Map<string, PromptSection>()
    for (const section of this.sections) sectionByName.set(section.name, section)
    for (const section of (scope === undefined ? [] : this.scopedSections.get(scope)) ?? []) {
      sectionByName.set(section.name, section)
    }
    // Tools: consult the global providers plus the scope's, each with this
    // assembly's context. `schemas` are what the model may see (already
    // post-restriction, per provider); `knownNames` (defaulting to the
    // schemas' names) form the pre-restriction universe `toolOrder` is
    // validated against, so a restricted-away tool is a normal absence while
    // a config typo still fails every assembly loudly.
    const providers = [
      ...this.toolProviders,
      ...(scope === undefined ? [] : this.scopedToolProviders.get(scope)) ?? [],
    ]
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(context)
      const schemas = result.schemas.map(({ name, description, parameters }): ToolSchema => ({
        name,
        description,
        parameters: structuredClone(parameters),
      }))
      const acceptedKnownNames = result.knownNames ?? schemas.map(tool => tool.name)
      collected.push(...schemas)
      for (const name of acceptedKnownNames) knownNames.add(name)
    }
    const assembly: PromptAssembly = {
      sections: [...sectionByName.values()]
        .map(section => ({
          name: section.name,
          order: section.order,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
        }))
        .sort((a, b) => a.order - b.order),
      tools: orderTools(collected, this.toolOrder, knownNames),
      variables,
    }
    return this.ctx.waterfall(
      scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )
  }
}

export default SystemPrompt
