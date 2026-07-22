import type { Context } from 'cordis'
import type { GenerateOptions, LlmModelContext, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

const CONTROL_PROBE = '\u001b]2;MODEL_CONTROLLED\u0007\u001b[999CMODEL_CURSOR\u009b31mMODEL_C1'
const INITIAL_TEXT = `I need one decision before I continue. ${CONTROL_PROBE}`
const FINAL_TEXT = 'Decision received. Scripted TUI run complete.'
// The `skill` scenario types `/skill:scripted-skill`; the manual-invocation front
// door delivers the loaded skill as a user turn wrapped in `<skill name="…">`. The
// body marker below lives in the fixture skill, so echoing it back proves the whole
// block (name attribute plus body) reached the model, not just the command text.
const SKILL_BLOCK_OPEN = '<skill name="scripted-skill">'
const SKILL_BODY_MARKER = 'SCRIPTED SKILL BODY MARKER'
const SKILL_RECEIVED_TEXT = 'Scripted skill body received.'
const TITLE_TEXT = 'scripted session title'

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Keyless adapter for the real-PTY TUI tests: the two-step conversation and the `/skill:` round-trip. */
class ScriptedTuiAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'tui-scripted-model', name: 'Scripted Base' },
      { provider, id: 'tui-scripted-model-pro', name: 'Scripted Pro' },
    ])
  }

  override resolveModelContext(_provider: string, _model: string): Promise<LlmModelContext> {
    return Promise.resolve({ contextWindow: 128_000 })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The session-title provider's auxiliary request carries no tool schemas,
    // unlike every agent turn; answer it with a fixed title so the PTY test can
    // assert the logged title reaches the terminal window title.
    if ((options.tools?.length ?? 0) === 0) {
      for (const chunk of textChunks(TITLE_TEXT)) yield chunk
      return
    }
    if (options.model !== 'tui-scripted-model-pro' || !options.system?.includes('tui-scripted-model-pro')) {
      throw new Error('the scripted TUI request did not apply the selected model to routing and prompt variables')
    }
    const lastMessage = options.messages.at(-1)
    const lastText = (lastMessage?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (lastText.includes(SKILL_BLOCK_OPEN)) {
      const ack = lastText.includes(SKILL_BODY_MARKER)
        ? SKILL_RECEIVED_TEXT
        : 'Scripted skill block arrived without its body.'
      for (const chunk of textChunks(ack)) yield chunk
      return
    }

    const hasToolResult = lastMessage?.content.some(block => block.type === 'tool-result') ?? false
    if (hasToolResult) {
      for (const chunk of textChunks(FINAL_TEXT)) yield chunk
      return
    }

    const args = JSON.stringify({
      questions: [{
        id: 'mode',
        header: 'Execution mode',
        question: 'How should the scripted run proceed?',
        options: [
          { label: 'Safe', description: 'Use the guarded path.' },
          { label: 'Fast', description: 'Use the shorter path.' },
        ],
      }],
    })
    const callId = CallId('call-ask-mode')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const char of INITIAL_TEXT) yield { type: 'text-delta', index: 0, text: char }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: INITIAL_TEXT } }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: callId, name: 'ask_user_question', argumentsDelta: args }
    yield {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: args },
    }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'tui-scripted-llm'
export const inject = ['llm']

/** Register the network-free adapter used by the PTY fixture. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['tui-scripted'], new ScriptedTuiAdapter())
}
