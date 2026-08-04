/** Deterministic parent model and process-quiescence observer for the Codex Loader snapshot. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

const CODEX_TASK = 'Return the Loader snapshot sentinel exactly.'
const QUIESCENCE_FILE = '.codex-quiescence.json'

function toolResultText(options: GenerateOptions): string {
  return options.messages.at(-1)?.content
    .filter(block => block.type === 'tool-result')
    .flatMap(block => block.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
}

class CodexDelegatingAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const result = toolResultText(options)
    if (result.length === 0) {
      const args = JSON.stringify({
        description: 'Codex Loader snapshot',
        prompt: CODEX_TASK,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: CallId('call-codex-loader'),
        name: 'subagent_codex',
        argumentsDelta: args,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: CallId('call-codex-loader'),
          name: 'subagent_codex',
          arguments: args,
        },
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const reply = `Codex child returned: ${result}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: reply.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface ObservedProcess {
  readonly spec: SubprocessSpawnSpec
  readonly handle: SubprocessHandle
}

export const name = 'codex-loader-snapshot-fixture'
export const inject = ['llm', 'subprocess']

/**
 * Register the deterministic parent adapter and record whether every spawned
 * product tree was already quiet when the assembled application disposed.
 * @param ctx - Loader context supplying the LLM and subprocess seams.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new CodexDelegatingAdapter())
  ctx.effect(() => {
    const observed: ObservedProcess[] = []
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    ctx.subprocess.spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
      const handle = originalSpawn(spec)
      observed.push({ spec, handle })
      return handle
    }
    return async () => {
      ctx.subprocess.spawn = originalSpawn
      const alreadyExited = AbortSignal.abort()
      const processes = await Promise.all(observed.map(async ({ spec, handle }) => ({
        argv: [...spec.argv],
        quiescent: await handle.waitForExit(alreadyExited),
        outcome: await handle.done,
      })))
      await writeFile(
        join(process.cwd(), QUIESCENCE_FILE),
        `${JSON.stringify({ processes })}\n`,
      )
    }
  }, 'codex Loader snapshot process observer')
}
