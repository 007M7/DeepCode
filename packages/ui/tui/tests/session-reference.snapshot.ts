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
import SessionQueryService from '@deepseek-ai/dsh-session-query'
import SessionReferenceService, { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { createTuiChat } from '../src/index.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const EXPECTED = join(dirname(fileURLToPath(import.meta.url)), 'snapshots/session-reference.expected.txt')
const REFRESHING = process.env.DSH_SNAPSHOT === 'refresh'

class SnapshotAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Snapshot reference accepted.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Snapshot reference accepted.' } }
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
    await ctx.plugin(SessionQueryService)
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
    const context = target.session.events.find(event => event.type === 'context/message')
    expect(context?.type === 'context/message' && context.data.meta).toMatchObject({
      kind: 'session-reference',
      references: [{ sessionId: 'source-session', compacted: true }],
    })

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
