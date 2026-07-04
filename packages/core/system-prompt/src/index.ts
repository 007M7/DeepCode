/**
 * System prompt assembly registry. Plugins contribute ordered text sections,
 * tool schema providers, and named prompt variables; `assemble(context)`
 * collates them through a waterfall that runs once per step, and
 * `renderPrompt` interpolates `{{variable}}` references into the final text.
 *
 * @module @deepseek-ai/dsh-system-prompt
 */

import { Context, Service } from 'cordis'
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
     * @param assembly - the assembly built from the registered sections, tool
     *   providers, and variable providers; listeners may mutate it or return a
     *   replacement.
     * @param context - the per-assembly {@link AssembleContext} the caller
     *   passed to {@link SystemPrompt.assemble} (e.g. which agent the prompt
     *   is for), so a listener can filter or extend per agent.
     * @mode waterfall
     */
    'system-prompt/assemble'(this: SystemPrompt, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * A section, tool provider, or variable provider was registered or
     * unregistered (the assembly inputs changed).
     * @mode emit
     */
    'system-prompt/change'(): void
  }
}

/**
 * Per-assembly input: what one {@link SystemPrompt.assemble} call is FOR.
 * Declared empty here so this package stays agnostic of who assembles;
 * merge-extensible — `@deepseek-ai/dsh-agent` declares the `agent` field, so
 * section text and variable providers can be functions of the calling agent.
 * Every field is optional by nature: a bare `assemble()` (tests, diagnostics)
 * carries an empty context, and providers must tolerate absent fields.
 */
export interface AssembleContext {}

/** One contributed section of the system prompt (registry input). */
export interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  name: string
  /**
   * Sections are concatenated in ascending order. Convention: `0` is the
   * per-agent persona, tool guidance uses 100–199; negative orders render
   * before the persona.
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
 * The assembled prompt.
 *
 * Tool schemas are part of the assembly by design: "what the model is told it
 * can do" is one coherent thing managed here, even though adapters transmit
 * `tools` as a separate wire field rather than prompt text.
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

/** A complete `{{...}}` reference group (any inner content, validated after). */
const REFERENCE = /\{\{([^{}]*)\}\}/g

/**
 * Renders the text part of an assembly: interpolates `{{variable}}`
 * references in each section from `assembly.variables`, drops empty sections,
 * and joins the rest with blank lines.
 *
 * Strict by design (fail loud beats shipping a malformed prompt): a reference
 * to an unregistered variable, to a registered variable with no value for
 * this assembly, or a complete `{{...}}` group that is not a well-formed
 * variable name (e.g. `{{ model }}`) throws. Only complete double-brace
 * groups are interpreted; a lone `{{` without a closing `}}` passes through
 * verbatim.
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section, assembly.variables))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/** Interpolate one section's `{{variable}}` references (see {@link renderPrompt}). */
function interpolate(section: AssembledSection, variables: Record<string, string | undefined>): string {
  return section.text.replace(REFERENCE, (_match, name: string) => {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in section "${section.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    if (!(name in variables)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in section "${section.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (section "${section.name}")`)
    }
    return value
  })
}

/**
 * Registry service (`ctx.systemPrompt`): plugins contribute ordered text
 * sections, tool-schema providers, and named prompt variables; the agent loop
 * calls `assemble(context)` once per step.
 */
export class SystemPrompt extends Service {
  private sections: PromptSection[] = []
  private toolProviders: (() => ToolSchema[])[] = []
  private variableProviders = new Map<string, (context: AssembleContext) => string | undefined>()

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  /**
   * Contribute a text section to the system prompt. Order is determined by
   * `section.order` (ascending). Throws if a section with the same name is
   * already registered (a duplicate would silently double prompt text — e.g.
   * a double-loaded tool plugin). The section is removed when the calling
   * fiber is disposed. Emits `system-prompt/change` on register/unregister.
   * @param section - the section to contribute (name, order, text or provider).
   * @returns the disposer that removes the section.
   */
  section(section: PromptSection): () => void {
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      if (this.sections.some(existing => existing.name === section.name)) {
        throw new Error(`prompt section "${section.name}" is already registered`)
      }
      this.sections.push(section)
      // Yield the rollback BEFORE emitting `system-prompt/change`: a generator
      // effect collects each yielded disposer before the next step runs, so a
      // throwing change listener removes the section instead of leaking it into
      // every future assembly.
      yield () => {
        const index = this.sections.indexOf(section)
        /* v8 ignore next 3 -- defensive: section was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) this.sections.splice(index, 1)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.section()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Contribute a tool-schema provider that is evaluated at each assembly
   * call (so it can reflect the live registry state). The provider is
   * removed when the calling fiber is disposed. Emits `system-prompt/change`.
   * @param provider - evaluated at every {@link assemble} for fresh schemas.
   * @returns the disposer that removes the provider.
   */
  tools(provider: () => ToolSchema[]): () => void {
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      this.toolProviders.push(provider)
      // Yield the rollback BEFORE emitting `system-prompt/change` (see section()).
      yield () => {
        const index = this.toolProviders.indexOf(provider)
        /* v8 ignore next 3 -- defensive: provider was registered, so indexOf is guaranteed >= 0 */
        if (index >= 0) this.toolProviders.splice(index, 1)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.tools()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Contribute a named prompt variable, referenced from section text as
   * `{{name}}`. The provider is evaluated at each assembly with that
   * assembly's {@link AssembleContext}; returning `undefined` means "no value
   * for this assembly" (a section referencing it then fails to render — a
   * deployment must not claim facts it does not have). Throws on a name that
   * does not match `[a-z][a-z0-9_]*` (it could never be referenced) or is
   * already registered. Removed when the calling fiber is disposed; emits
   * `system-prompt/change` on register/unregister.
   * @param name - the reference name (matches `[a-z][a-z0-9_]*`).
   * @param provider - evaluated at every {@link assemble} for the value.
   * @returns the disposer that removes the variable.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    const dispose = this.ctx.effect(function* (this: SystemPrompt) {
      if (!VARIABLE_NAME.test(name)) {
        throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
      }
      if (this.variableProviders.has(name)) {
        throw new Error(`prompt variable "${name}" is already registered`)
      }
      this.variableProviders.set(name, provider)
      // Yield the rollback BEFORE emitting `system-prompt/change` (see section()).
      yield () => {
        this.variableProviders.delete(name)
        this.ctx.emit('system-prompt/change')
      }
      this.ctx.emit('system-prompt/change')
    }.bind(this), 'systemPrompt.variable()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Assemble the current prompt for one caller: section texts are resolved
   * against `context` and sorted by order, tools collected from all
   * providers, and every registered variable resolved against `context` into
   * `assembly.variables`. Tool schemas are deep-cloned because adapters and
   * request waterfalls may mutate schema objects. Runs through the
   * `system-prompt/assemble` waterfall, giving listeners the opportunity to
   * mutate or replace the assembly before it reaches the model. Await the
   * result before reading the assembly values — waterfall listeners may be
   * async. Interpolation happens later, in {@link renderPrompt}.
   * @param context - what this assembly is for (defaults to an empty context;
   *   see {@link AssembleContext}).
   * @returns the assembly after the waterfall has run.
   */
  assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variableProviders) {
      variables[name] = provider(context)
    }
    const assembly: PromptAssembly = {
      sections: this.sections
        .map(section => ({
          name: section.name,
          order: section.order,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
        }))
        .sort((a, b) => a.order - b.order),
      tools: this.toolProviders.flatMap(provider =>
        provider().map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) }))),
      variables,
    }
    return this.ctx.waterfall(this, 'system-prompt/assemble', assembly, context, () => Promise.resolve(assembly))
  }
}

export default SystemPrompt
