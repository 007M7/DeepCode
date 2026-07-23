import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandService from '@deepseek-ai/dsh-commands'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import SessionReferenceService, { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { createTuiChat } from '../src/index.ts'
import { HeadlessTerminal } from './headless-terminal.ts'
import { TestSessionQueryService } from './session-query.ts'

const EXPECTED = join(dirname(fileURLToPath(import.meta.url)), 'snapshots/session-reference.expected.txt')
const REFRESHING = process.env.DSH_SNAPSHOT === 'refresh'

class SnapshotAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const prompt = options.messages.at(-1)
    if (prompt?.role !== 'user' || prompt.content.length !== 3
      || prompt.content[1]?.type !== 'text' || prompt.content[1].text !== '\n\n## My request:\n') {
      throw new Error('session reference did not reach the model as one prefixed user message')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Combined reference request accepted.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Combined reference request accepted.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function nextIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

describe('TUI session-reference snapshot', () => {
  it('snapshots compacted current-surface context on send and displays only its reference card', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestSessionQueryService)
    await ctx.plugin(SessionReferenceService)

    const adapter = new SnapshotAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const source = ctx.sessions.create(SessionId('source-session'), { meta: { cwd: '/workspace/project', createdAt: 1 } })
    const oldUser = source.append('user/message', {
      content: [{ type: 'text', text: 'SHADOWED OLD USER' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const oldAssistant = source.append('assistant/message', {
      turn: 1,
      step: 1,
      provenance: { provider: 'mock', model: 'mock' },
      content: [{ type: 'text', text: 'SHADOWED OLD ASSISTANT' }],
    }, { surfaceOp: 'append' })
    source.append('user/message', {
      content: [{ type: 'text', text: '<compacted-summary>Retained checkpoint.</compacted-summary>' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }, {
      surfaceOp: { op: 'replace', start: oldUser.seq, end: oldAssistant.seq },
      sourceEventSeqs: [oldUser.seq, oldAssistant.seq],
    })
    source.append('user/message', {
      content: [{ type: 'text', text: 'Recent retained question.' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    const target = ctx.agentLoop.create(
      SessionId('target-session'),
      { provider: 'mock', model: 'mock' },
      { cwd: '/workspace/project' },
    )
    const terminal = new HeadlessTerminal(96, 24)
    const controller = createTuiChat(ctx, {
      sessionId: target.id,
      welcome: 'Session reference snapshot.',
      color: true,
      title: 'DSH session reference',
    }, { terminal, exit: () => {} })
    await terminal.waitForFrame(0)

    const mention = formatSessionReferenceMention({ sessionId: source.id, label: 'Source session' })
    const idle = nextIdle(ctx, target)
    const frame = terminal.frames
    terminal.send(`Use ${mention}`)
    terminal.send('\r')
    await idle
    await terminal.waitForFrame(frame)

    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('untrusted, read-only snapshot')
    expect(request).toContain('Retained checkpoint.')
    expect(request).toContain('Recent retained question.')
    expect(request).not.toContain('SHADOWED OLD USER')
    expect(request).not.toContain('SHADOWED OLD ASSISTANT')
    const user = target.session.events.find(event => event.type === 'user/message')
    expect(user?.type === 'user/message' && user.data.envelope).toMatchObject({
      displayContent: [{ type: 'text', text: 'Use @Source session' }],
      prefixContexts: [{
        source: { kind: 'plugin', plugin: 'session-reference' },
        meta: {
          kind: 'session-reference',
          references: [{ sessionId: 'source-session', compacted: true }],
        },
      }],
    })
    expect(user?.type === 'user/message' && user.data.content[1]).toEqual({
      type: 'text',
      text: '\n\n## My request:\n',
    })
    expect(target.session.events.some(event => event.type === 'user/message' && event.data.source.kind !== 'user')).toBe(false)

    const snapshot = await terminal.snapshot({ includeScrollback: true })
    if (REFRESHING) {
      await mkdir(dirname(EXPECTED), { recursive: true })
      await writeFile(EXPECTED, snapshot)
    }
    await expect(snapshot).toMatchFileSnapshot(EXPECTED)

    await controller.dispose()
    await ctx.fiber.dispose()
    await terminal.dispose()
  })
})
