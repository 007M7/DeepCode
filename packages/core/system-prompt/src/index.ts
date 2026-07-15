/**
 * Registry for ordered prompt sections, tool schemas, and prompt variables.
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
     * Expert waterfall over the assembled sections, tools, and variables.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only that scope's assemblies. The returned value is authoritative.
     * @param assembly - the mutable assembly built from registered providers.
     * @param context - the caller's per-assembly context.
     * @mode waterfall
     */
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * Emitted when any prompt provider changes. This registry notification is
     * unfiltered because a global change affects every scope.
     * @mode emit
     */
    'system-prompt/change'(): void
  }
}

/** Merge-extensible context for one prompt assembly. */
export interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
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
  // TODO(assembled-section-order): drop this output field; registry order has
  // already sorted the array, and no production renderer/listener reads it.
  /** The contributing section's order (sections arrive sorted ascending). */
  order: number
  /** The resolved (but not yet interpolated) section text. */
  text: string
}

/** Tool schemas visible in one assembly and their pre-restriction name set. */
export interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}

/**
 * Merge-extensible assembled prompt. Sections remain uninterpolated until
 * {@link renderPrompt}; tools are already in canonical model-facing order.
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

/** Reserved {@link Config.toolOrder} marker for unlisted tools. */
export const TOOL_ORDER_REST = '<unlisted-tools>'

/**
 * Validate duplicate names and the required {@link TOOL_ORDER_REST} marker.
 * Registered names are checked later because plugins have not loaded yet.
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
 * Apply configured tool order, inserting unlisted tools lexicographically at
 * {@link TOOL_ORDER_REST}. Unknown configured names fail; known but restricted
 * names may be absent.
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
   * Deployment-wide order-0 persona template. A scoped section named
   * `deployment:persona` shadows it; `{{variable}}` references are strict.
   */
  persona?: string
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Shape errors fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[]
}

/**
 * Interpolate strict `{{variable}}` references, drop empty sections, and join
 * the rest with blank lines. Malformed, unknown, or undefined references throw;
 * a lone `{{` without any later `}}` is literal prose, and substituted values
 * are not scanned again.
 * @param assembly - the assembly whose sections and variables to render.
 * @returns the rendered prompt, or `''` when all sections are empty.
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
      // A later closing brace makes this malformed; otherwise it is literal prose.
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in section "${section.name}" (references are complete simple {{name}} groups)`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // `{{}}` yields an empty name and follows the malformed-reference path.
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in section "${section.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // Do not resolve unregistered names through Object.prototype.
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

/** Registry service for the prompt inputs assembled before each model step. */
export class SystemPrompt extends Service {
  static Config: z<Config> = z.object({
    persona: z.string().default(''),
    // Preserve omission because an explicit empty order lacks the rest marker.
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

  constructor(ctx: Context, config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // Keep harness-owned openers independent of the selected loop plugin.
    this.section({
      name: 'harness:identity',
      order: -100,
      text: 'You are an AI agent powered by the DeepSeek Harness SDK.',
    })
    this.section({
      name: 'deployment:persona',
      order: 0,
      // The fallback narrows the optional input type; the schema already defaults it.
      text: config.persona ?? '',
    })
  }

  /**
   * Register an ordered prompt section in the calling context's scope. A scoped
   * section shadows a global section with the same name; duplicates within one
   * layer and non-finite orders throw. Registration and disposal emit
   * `system-prompt/change`.
   * @param section - the section to register.
   * @returns the exact Cordis effect disposer.
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
      // Install rollback before notifying listeners that may throw.
      yield () => {
        const index = layer.indexOf(section)
        /* v8 ignore next 3 -- defensive: section was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) layer.splice(index, 1)
        if (scope !== undefined && layer.length === 0) this.scopedSections.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.section()')
    // Return the exact disposer so composite effects preserve teardown order.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Register a tool-schema provider in the calling context's scope. Global and
   * matching scoped providers both contribute; returning the reserved
   * {@link TOOL_ORDER_REST} name makes assembly fail.
   * @param provider - evaluated for each assembly with its context.
   * @returns the exact Cordis effect disposer.
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
      // Install rollback before notifying listeners that may throw.
      yield () => {
        const index = layer.indexOf(provider)
        /* v8 ignore next 3 -- defensive: provider was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) layer.splice(index, 1)
        if (scope !== undefined && layer.length === 0) this.scopedToolProviders.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.tools()')
    // Return the exact disposer so composite effects preserve teardown order.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Register a prompt variable in the calling context's scope. Scoped values
   * shadow globals; invalid or duplicate names throw. A provider may return
   * `undefined`, but rendering a section that references that value then fails.
   * @param name - the `[a-z][a-z0-9_]*` reference name.
   * @param provider - evaluated for each assembly.
   * @returns the exact Cordis effect disposer.
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
      // Install rollback before notifying listeners that may throw.
      yield () => {
        layer.delete(name)
        if (scope !== undefined && layer.size === 0) this.scopedVariableProviders.delete(scope)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.variable()')
    // Return the exact disposer so composite effects preserve teardown order.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Assemble global and scoped providers, detach tool parameters, apply
   * canonical ordering, then run the assembly waterfall. Scoped sections and
   * variables shadow globals; the returned waterfall value is authoritative.
   * @param context - the optional scope and plugin-defined assembly fields.
   * @returns the authoritative post-waterfall assembly.
   */
  // Keep configuration failures on the declared asynchronous error path.
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const scope = context.scope
    // Scoped variables shadow globals.
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variableProviders) {
      variables[name] = provider(context)
    }
    const scopedVariables = scope === undefined ? undefined : this.scopedVariableProviders.get(scope)
    for (const [name, provider] of scopedVariables ?? []) {
      variables[name] = provider(context)
    }
    // Scoped sections shadow globals before the stable order sort.
    const sectionByName = new Map<string, PromptSection>()
    for (const section of this.sections) sectionByName.set(section.name, section)
    for (const section of (scope === undefined ? [] : this.scopedSections.get(scope)) ?? []) {
      sectionByName.set(section.name, section)
    }
    // Validate order against pre-restriction names while collecting visible schemas.
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
