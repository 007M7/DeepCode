import type { Context } from 'cordis'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Terminal marker the preset smoke waits for before it asks the TUI to exit. */
export const COMPOSITION_REPLY_TEXT = 'Shipped composition acknowledged.'

// Provider id and model the keyless tail routes `main` to; that overlay is the
// only caller, so the pair lives here as plain constants.
const COMPOSITION_PROVIDER = 'composition-keyless'
const COMPOSITION_MODEL = 'composition-keyless-model'

/**
 * Network-free adapter for the shipped-composition smoke. It answers every
 * request — tool-ful agent turns and the tool-less auxiliary calls alike — with
 * one fixed text and never calls a tool, because the assertion under test is the
 * assembled tool catalog the loop logs, not any tool's behavior.
 */
class CompositionEchoAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: COMPOSITION_MODEL, name: 'Preset Keyless' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Preset Keyless', context: { contextWindow: 128_000 } })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const char of COMPOSITION_REPLY_TEXT) yield { type: 'text-delta', index: 0, text: char }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: COMPOSITION_REPLY_TEXT } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: COMPOSITION_REPLY_TEXT.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'composition-echo-llm'
export const inject = ['llm']

/**
 * Register the network-free adapter the shipped-composition smoke routes through.
 * @param ctx - the loader-mounted plugin context.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([COMPOSITION_PROVIDER], new CompositionEchoAdapter())
}
