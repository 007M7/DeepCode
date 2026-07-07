/**
 * System prompt assembly registry. Plugins contribute ordered text sections,
 * tool schema providers, and named prompt variables; `assemble(context)`
 * collates them through a waterfall that runs once per step, and
 * `renderPrompt` interpolates `{{variable}}` references into the final text.
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

/** A complete `{{...}}` reference group at the scan position (validated after). */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.persona} for its contract). */
export interface Config {
  /**
   * The deployment's persona — the ONE deployment-authored fragment of the
   * system prompt, rendered as the order-0 `deployment:persona` section
   * (after the harness identity, before all tool guidance). Every agent in
   * the context shares it, subagents included. Template, not free-form text:
   * every complete `{{…}}` group is interpreted strictly against the
   * registered prompt variables (the shipped agent loop registers `{{model}}`
   * and `{{cwd}}`), and there is no escape syntax for literal `{{…}}` prose
   * yet (a deliberate deferral; see the prompt-variables RFC). Defaults to
   * `''` — the empty section is dropped at render, so a persona-less
   * deployment opens with the harness identity alone.
   */
  persona?: string
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
  })

  private sections: PromptSection[] = []
  private toolProviders: (() => ToolSchema[])[] = []
  private variableProviders = new Map<string, (context: AssembleContext) => string | undefined>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'systemPrompt')
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
