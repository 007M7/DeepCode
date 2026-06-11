import { Context, Service } from 'cordis'
import type { ContentBlock, GenerateOptions, GenerateResult, StreamChunk } from './types.ts'
import { BlockAssembler } from './assembler.ts'

export * from './types.ts'
export { BlockAssembler } from './assembler.ts'

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }

  interface Events {
    /** Waterfall around every streaming model call (retry, caching, routing). */
    'llm/stream'(this: LlmService, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
    /** Waterfall around every non-streaming model call. */
    'llm/generate'(this: LlmService, options: GenerateOptions, next: () => Promise<GenerateResult>): Promise<GenerateResult>
    /** An adapter was registered or unregistered. */
    'llm/adapter-change'(): void
  }
}

export class LlmError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'LlmError'
  }
}

/**
 * Base class for LLM provider adapters.
 *
 * An adapter translates between the harness vocabulary (Message/ContentBlock/
 * StreamChunk) and one provider's wire format. Adapters register themselves
 * via `ctx.llm.registerAdapter(models, adapter)`.
 *
 * TODO: the first real adapter (DeepSeek V4) lands in a later phase; until
 * then only mock adapters (tests, demo) exist.
 */
export abstract class LlmAdapter {
  /** Stream one model call as raw chunks. The only required method. */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * The abstract `llm` service: an adapter registry plus streaming /
 * non-streaming call surfaces, both interceptable via waterfall events.
 */
export class LlmService extends Service {
  private adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** Register an adapter for the given model names. Disposed with the fiber. */
  registerAdapter(models: string[], adapter: LlmAdapter): () => void {
    return this.ctx.effect(() => {
      for (const model of models) this.adapters.set(model, adapter)
      this.ctx.emit('llm/adapter-change')
      return () => {
        for (const model of models) this.adapters.delete(model)
        this.ctx.emit('llm/adapter-change')
      }
    }, 'llm.registerAdapter()')
  }

  /** Model names with a registered adapter. */
  models(): string[] {
    return [...this.adapters.keys()]
  }

  private adapter(model: string): LlmAdapter {
    const adapter = this.adapters.get(model)
    if (!adapter) throw new LlmError(`no adapter registered for model "${model}"`, 'NO_ADAPTER')
    return adapter
  }

  /** Stream one model call as raw chunks (token-level deltas). */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(this, 'llm/stream', options, () => {
      return this.adapter(options.model).stream(options)
    })
  }

  /**
   * Stream one model call as completed content blocks — a convenience view
   * for consumers that don't care about token-level deltas.
   */
  async * streamBlocks(options: GenerateOptions): AsyncIterable<ContentBlock> {
    const assembler = new BlockAssembler()
    for await (const chunk of this.stream(options)) {
      const block = assembler.push(chunk)
      if (block) yield block
    }
  }

  /** One model call, fully assembled (drains the chunk stream). */
  generate(options: GenerateOptions): Promise<GenerateResult> {
    return this.ctx.waterfall(this, 'llm/generate', options, async () => {
      const assembler = new BlockAssembler()
      for await (const chunk of this.stream(options)) assembler.push(chunk)
      return assembler.result()
    })
  }
}

export default LlmService
