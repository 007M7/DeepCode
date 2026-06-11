/**
 * System prompt assembly registry. Plugins contribute ordered text sections and
 * tool schema providers; `assemble()` collates them through a waterfall that
 * runs once per step.
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
    /** Waterfall around prompt assembly — mutate/extend the assembly. */
    'system-prompt/assemble'(this: SystemPrompt, assembly: PromptAssembly, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /** A section or tool provider was registered or unregistered. */
    'system-prompt/change'(): void
  }
}

/** One contributed section of the system prompt. */
export interface PromptSection {
  /** Unique name (diagnostics / dedup). */
  name: string
  /** Sections are concatenated in ascending order. */
  order: number
  /** Static text or a provider evaluated at each assembly. */
  text: string | (() => string)
}

/**
 * The assembled prompt.
 *
 * Tool schemas are part of the assembly by design: "what the model is told it
 * can do" is one coherent thing managed here, even though adapters transmit
 * `tools` as a separate wire field rather than prompt text.
 *
 * Merge-extensible: plugins can declare extra fields on this interface.
 */
export interface PromptAssembly {
  sections: PromptSection[]
  tools: ToolSchema[]
}

/** Renders the text part of an assembly (sections joined by blank lines). */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => typeof section.text === 'function' ? section.text() : section.text)
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * Registry service (`ctx.systemPrompt`): plugins contribute ordered text
 * sections and tool-schema providers; the agent loop calls `assemble()` once
 * per step.
 */
export class SystemPrompt extends Service {
  private sections: PromptSection[] = []
  private toolProviders: (() => ToolSchema[])[] = []

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  /**
   * Contribute a text section to the system prompt. Order is determined by
   * `section.order` (ascending). The section is removed when the calling
   * fiber is disposed. Emits `system-prompt/change` on register/unregister.
   */
  section(section: PromptSection): () => void {
    const dispose = this.ctx.effect(() => {
      this.sections.push(section)
      this.ctx.emit('system-prompt/change')
      return () => {
        const index = this.sections.indexOf(section)
        if (index >= 0) this.sections.splice(index, 1)
        this.ctx.emit('system-prompt/change')
      }
    }, 'systemPrompt.section()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Contribute a tool-schema provider that is evaluated at each assembly
   * call (so it can reflect the live registry state). The provider is
   * removed when the calling fiber is disposed. Emits `system-prompt/change`.
   */
  tools(provider: () => ToolSchema[]): () => void {
    const dispose = this.ctx.effect(() => {
      this.toolProviders.push(provider)
      this.ctx.emit('system-prompt/change')
      return () => {
        const index = this.toolProviders.indexOf(provider)
        if (index >= 0) this.toolProviders.splice(index, 1)
        this.ctx.emit('system-prompt/change')
      }
    }, 'systemPrompt.tools()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Assemble the current prompt (sections sorted by order, tools collected
   * from all providers). Runs through the `system-prompt/assemble` waterfall,
   * giving listeners the opportunity to mutate or replace the assembly before
   * it reaches the model. Await the result before reading the assembly values —
   * waterfall listeners may be async.
   */
  assemble(): Promise<PromptAssembly> {
    const assembly: PromptAssembly = {
      sections: [...this.sections].sort((a, b) => a.order - b.order),
      tools: this.toolProviders.flatMap(provider => provider()),
    }
    return this.ctx.waterfall(this, 'system-prompt/assemble', assembly, () => Promise.resolve(assembly))
  }
}

export default SystemPrompt
