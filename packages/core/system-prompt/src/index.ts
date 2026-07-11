/**
 * System prompt assembly registry.
 * Scope-filtered dispatch: keyed to `context.scope`.
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
     * Waterfall around prompt assembly — mutate or extend the {@link PromptAssembly}
     * (sections + tools + variables) before it is rendered.
     *
     * @param assembly - the assembly built from the registered sections, tool providers,
     *   and variable providers; listeners may mutate it or return a replacement.
     * @param context - the per-assembly {@link AssembleContext} the caller passed to {@link
     *   SystemPrompt.assemble} (e.g. which agent the prompt is for), so a listener can
     *   filter or extend per agent.
     * @mode waterfall
     */
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * A section, tool provider, variable provider, or protection was registered
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
  name: string
  /**
   * Sections are concatenated in ascending order. Convention: `-100` is the
   * harness identity, `0` the deployment persona, tool guidance uses 100–199;
   * other negative orders also render before the persona.
   */
  order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}.
   */
  text: string | ((context: AssembleContext) => string)
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
  schemas: ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  knownNames?: readonly string[]
}

/**
 * Canonical prompt contributions that survive the assembly waterfall.
 */
export interface PromptProtection {
  /** Section names whose canonical registry output is authoritative. */
  sections?: readonly string[]
  /** Tool names whose canonical provider output is authoritative. */
  tools?: readonly string[]
}

/**
 * The assembled prompt.
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
 * Order collected tool schemas by the validated policy: with no configured list, plain
 * lexicographic name order; with one, listed names take their listed position and every
 * unlisted tool lands at the {@link TOOL_ORDER_REST} rest entry in lexicographic name order.
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

/** Restore protected named entries from `canonical`, anchored before their next unprotected canonical neighbor. */
function restoreProtected<T extends { name: string }>(
  canonical: readonly T[], result: readonly T[], protectedNames: ReadonlySet<string>,
): T[] {
  const restored = result.filter(entry => !protectedNames.has(entry.name))
  for (const [index, entry] of canonical.entries()) {
    if (!protectedNames.has(entry.name)) continue
    // Protected entries are inserted in canonical order.
    const following = new Set(
      canonical.slice(index + 1)
        .filter(candidate => !protectedNames.has(candidate.name))
        .map(candidate => candidate.name),
    )
    const next = restored.findIndex(candidate => following.has(candidate.name))
    restored.splice(next < 0 ? restored.length : next, 0, structuredClone(entry))
  }
  return restored
}

/** Lexicographic (code-unit) name comparison — locale-independent, so the order is identical on every machine. */
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.persona} for its contract). */
export interface Config {
  /**
   * The deployment's persona — the one deployment-authored fragment of the system prompt,
   * rendered as the order-0 `deployment:persona` section (after the harness identity, before
   * all tool guidance).
   */
  persona?: string
  /**
   * Explicit model-facing tool order, as a list of `ToolSchema.name`s: listed tools take their
   * listed position, and tools absent from the list are inserted at the {@link
   * TOOL_ORDER_REST} (`'<unlisted-tools>'`) entry in lexicographic name order.
   */
  toolOrder?: string[]
}

/**
 * Renders the text part of an assembly: interpolates `{{variable}}` references in each section
 * from `assembly.variables`, drops empty sections, and joins the rest with blank lines.
 *
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
 * sections, tool-schema providers, named prompt variables, and authoritative
 * contribution protections; the agent loop calls `assemble(context)` once per
 * step. Registers the harness-owned `harness:identity` and
 * `deployment:persona` sections itself (see {@link Config.persona}).
 */
export class SystemPrompt extends Service {
  static Config: z<Config> = z.object({
    persona: z.string().default(''),
    // A schemastery array defaults to [] when omitted, but an omitted toolOrder must stay
    // absent ("lexicographic order"), not become an explicitly-configured empty list (which is
    // invalid — it lacks the rest entry).
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private sections: PromptSection[] = []
  private toolProviders: ((context: AssembleContext) => ToolProviderResult)[] = []
  private variableProviders = new Map<string, (context: AssembleContext) => string | undefined>()
  private protections: PromptProtection[] = []
  /** Per-scope layers (`@deepseek-ai/dsh-scope`); entries drop when a layer empties, so a disposed scope leaves no residue. */
  private scopedSections = new Map<ScopeKey, PromptSection[]>()
  private scopedToolProviders = new Map<ScopeKey, ((context: AssembleContext) => ToolProviderResult)[]>()
  private scopedVariableProviders = new Map<ScopeKey, Map<string, (context: AssembleContext) => string | undefined>>()
  private scopedProtections = new Map<ScopeKey, PromptProtection[]>()
  private readonly toolOrder: string[] | undefined

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // The harness-owned openers.
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
   * Contribute a text section to the system prompt.
   *
   * @param section - the section to contribute (name, order, text or provider).
   * @returns the disposer that removes the section. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  section(section: PromptSection): () => Promise<void> | void {
    const scope = scopeOf(this.ctx)
    const snapshot: PromptSection = {
      name: section.name,
      order: section.order,
      text: section.text,
    }
    if (scope !== undefined && this.protections.some(record => record.sections?.includes(snapshot.name))) {
      throw new Error(`prompt section "${snapshot.name}" is globally protected and cannot be shadowed in an agent scope`)
    }
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      const layer = scope === undefined
        ? this.sections
        : this.scopedSections.get(scope) ?? (() => {
          const created: PromptSection[] = []
          this.scopedSections.set(scope, created)
          return created
        })()
      if (layer.some(existing => existing.name === snapshot.name)) {
        throw new Error(scope === undefined
          ? `prompt section "${snapshot.name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
          : `prompt section "${snapshot.name}" is already registered in this scope`)
      }
      layer.push(snapshot)
      // Yield the rollback BEFORE emitting `system-prompt/change`: a generator
      // effect collects each yielded disposer before the next step runs, so a
      // throwing change listener removes the section instead of leaking it into
      // every future assembly.
      yield () => {
        const index = layer.indexOf(snapshot)
        /* v8 ignore next 3 -- defensive: section was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) layer.splice(index, 1)
        if (scope !== undefined && layer.length === 0) this.scopedSections.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.section()')
    // Return the exact Cordis disposer so generator effects preserve teardown nesting.
    return dispose
  }

  /**
   * Contribute a tool-schema provider, evaluated at each assembly call with that assembly's
   * {@link AssembleContext} (so it reflects the live registry state AND the assembly's scope —
   * see {@link ToolProviderResult} for the `schemas`/`knownNames` split).
   *
   * @param provider - evaluated at every {@link assemble} for fresh schemas.
   * @returns the disposer that removes the provider. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => Promise<void> | void {
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
    // Return the exact Cordis disposer so generator effects preserve teardown nesting.
    return dispose
  }

  /**
   * Contribute a named prompt variable, referenced from section text as `{{name}}`.
   *
   * @param name - the reference name (matches `[a-z][a-z0-9_]*`).
   * @param provider - evaluated at every {@link assemble} for the value.
   * @returns the disposer that removes the variable. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => Promise<void> | void {
    const scope = scopeOf(this.ctx)
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      if (!VARIABLE_NAME.test(name)) {
        throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
      }
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
    // Return the exact Cordis disposer so generator effects preserve teardown nesting.
    return dispose
  }

  /**
   * Protect named section/tool contributions from the assembly waterfall.
   *
   * @param protection - section and/or tool names whose canonical presence and definitions are authoritative.
   * @returns the exact Cordis effect disposer that removes the protection.
   */
  protect(protection: PromptProtection): () => Promise<void> | void {
    const scope = scopeOf(this.ctx)
    const snapshot: PromptProtection = {
      ...protection.sections !== undefined ? { sections: [...new Set(protection.sections)] } : {},
      ...protection.tools !== undefined ? { tools: [...new Set(protection.tools)] } : {},
    }
    if ((snapshot.sections?.length ?? 0) === 0 && (snapshot.tools?.length ?? 0) === 0) {
      throw new Error('systemPrompt.protect() requires at least one section or tool name')
    }
    if (scope === undefined && snapshot.sections !== undefined) {
      const protectedSections = new Set(snapshot.sections)
      const conflicts = [...this.scopedSections.values()]
        .flatMap(layer => layer.filter(section => protectedSections.has(section.name)).map(section => section.name))
      if (conflicts.length > 0) {
        throw new Error(`systemPrompt.protect() cannot globally protect section${conflicts.length > 1 ? 's' : ''} ${[...new Set(conflicts)].map(name => `"${name}"`).join(', ')} while scoped shadows are registered`)
      }
    }
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      const layer = scope === undefined
        ? this.protections
        : this.scopedProtections.get(scope) ?? (() => {
          const created: PromptProtection[] = []
          this.scopedProtections.set(scope, created)
          return created
        })()
      layer.push(snapshot)
      yield () => {
        const index = layer.indexOf(snapshot)
        /* v8 ignore next 3 -- defensive: protection was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) layer.splice(index, 1)
        if (scope !== undefined && layer.length === 0) this.scopedProtections.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.protect()')
    return dispose
  }

  /** Resolve the authoritative names registered for one assembly scope. */
  private protectedNames(scope: ScopeKey | undefined): { sections: Set<string>; tools: Set<string> } {
    const records = [
      ...this.protections,
      ...(scope === undefined ? [] : this.scopedProtections.get(scope)) ?? [],
    ]
    return {
      sections: new Set(records.flatMap(record => record.sections ?? [])),
      tools: new Set(records.flatMap(record => record.tools ?? [])),
    }
  }

  /**
   * Assemble global contributions with one scope, then run the assembly waterfall and protection.
   * @param context - assembly subject and scope; defaults to an empty context.
   * @returns the assembly after the waterfall has run.
   */
  // Async ensures validation failures are promise rejections.
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const scope = context.scope
    // Registrations arriving mid-assembly affect the next assembly.
    const protectedNames = this.protectedNames(scope)
    // Scoped variables shadow global names.
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variableProviders) {
      variables[name] = provider(context)
    }
    const scopedVariables = scope === undefined ? undefined : this.scopedVariableProviders.get(scope)
    for (const [name, provider] of scopedVariables ?? []) {
      variables[name] = provider(context)
    }
    // Scoped sections shadow global names before the stable order sort.
    const sectionByName = new Map<string, PromptSection>()
    for (const section of this.sections) sectionByName.set(section.name, section)
    for (const section of (scope === undefined ? [] : this.scopedSections.get(scope)) ?? []) {
      sectionByName.set(section.name, section)
    }
    // `knownNames` validates order before per-scope restrictions hide schemas.
    const providers = [
      ...this.toolProviders,
      ...(scope === undefined ? [] : this.scopedToolProviders.get(scope)) ?? [],
    ]
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(context)
      for (const tool of result.schemas) {
        collected.push({ ...tool, parameters: structuredClone(tool.parameters) })
      }
      for (const name of result.knownNames ?? result.schemas.map(tool => tool.name)) {
        knownNames.add(name)
      }
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
    // Snapshot only the fields protection can restore. The waterfall receives
    // `assembly` by reference and may mutate it or return a replacement; these
    // independent snapshots remain the authoritative registry product.
    const canonicalSections = protectedNames.sections.size > 0 ? structuredClone(assembly.sections) : undefined
    const canonicalTools = protectedNames.tools.size > 0 ? structuredClone(assembly.tools) : undefined
    const result = await this.ctx.waterfall(
      scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )
    // Build a replacement instead of mutating the waterfall result: a
    // listener may legitimately return a frozen assembly. Merge-extensible
    // fields ride through the spread untouched.
    return {
      ...result,
      ...canonicalSections !== undefined
        ? { sections: restoreProtected(canonicalSections, result.sections, protectedNames.sections) }
        : {},
      ...canonicalTools !== undefined
        ? { tools: restoreProtected(canonicalTools, result.tools, protectedNames.tools) }
        : {},
    }
  }
}

export default SystemPrompt
