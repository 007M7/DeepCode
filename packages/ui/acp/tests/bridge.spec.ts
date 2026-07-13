import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, toolCallResponse, type BridgeHarness } from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * End-to-end bridge specs over an in-memory transport: a real
 * ClientSideConnection drives the bridge's AgentSideConnection, so every
 * assertion exercises actual JSON-RPC framing and the harness event taxonomy.
 */
describe('acp bridge', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'acp-test-'))
  })

  afterEach(async () => {
    // e2e/integration tests own their resources (docs/testing.md): dispose even on
    // failure so a flaky run never leaks a context or persistence dir.
    if (harness) await harness.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('initialize negotiates the protocol version and advertises capabilities', async () => {
    harness = await makeBridgeHarness({ storageDir })
    const res = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(res.agentCapabilities?.loadSession).toBe(true)
    expect(res.agentCapabilities?.promptCapabilities).toMatchObject({ image: false, audio: false })
    expect(res.agentInfo).toEqual({ name: 'deepseek-harness-acp', version: '0.0.1' })
  })

  it('session/new creates a session and a full prompt turn streams text then settles end_turn', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('hello there')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(sessionId).toBeTruthy()

    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(res.stopReason).toBe('end_turn')

    // The streamed text arrived as agent_message_chunk updates.
    const text = harness.updates
      .filter(u => u.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(text).toBe('hello there')
  })

  it('routes ask_user_question through ACP form elicitation and continues with the selected option', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      withAskUser: true,
      script: [
        toolCallResponse('ask-1', 'ask_user_question', {
          questions: [{
            id: 'language',
            header: 'Project config',
            question: 'Which language should I use?',
            options: [
              { label: 'TypeScript', description: 'Good for UI apps' },
              { label: 'Python', description: 'Good for scripts' },
            ],
          }],
        }),
        textResponse('Python it is.'),
      ],
    })
    harness.onElicitation = () => ({ action: 'accept', content: { choice: 'Python' } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'ask me' }] })

    expect(result.stopReason).toBe('end_turn')
    expect(harness.elicitationRequests).toHaveLength(1)
    expect(harness.elicitationRequests[0]).toMatchObject({
      sessionId,
      mode: 'form',
      message: 'Which language should I use?',
      requestedSchema: {
        title: 'Project config',
        properties: {
          choice: {
            oneOf: [
              { const: 'TypeScript', title: 'TypeScript: Good for UI apps' },
              { const: 'Python', title: 'Python: Good for scripts' },
            ],
          },
          custom: { type: 'string' },
        },
        required: [],
      },
    })
    const toolResult = harness.ctx.agents.get(SessionId(sessionId))!.session.events.find(event => event.type === 'tool/result')
    const toolResultBlock = toolResult?.type === 'tool/result' ? toolResult.data.content[0] : undefined
    const toolResultText = toolResultBlock?.type === 'text' ? toolResultBlock.text : undefined
    expect(toolResultText).toBe('{"answers":[{"id":"language","selected":["Python"]}]}')
  })

  it('routes optionless ask_user_question through an ACP free-form answer field', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      withAskUser: true,
      script: [
        toolCallResponse('ask-1', 'ask_user_question', {
          questions: [{ id: 'name', question: 'What should I name it?' }],
        }),
        textResponse('Name recorded.'),
      ],
    })
    harness.onElicitation = () => ({ action: 'accept', content: { custom: 'apollo' } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'ask me' }] })

    expect(harness.elicitationRequests[0]).toMatchObject({
      requestedSchema: {
        properties: { custom: { type: 'string', title: 'What should I name it?' } },
        required: ['custom'],
      },
    })
    const toolResult = harness.ctx.agents.get(SessionId(sessionId))!.session.events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('apollo')
  })

  it('supports ACP custom answers alongside choices', async () => {
    harness = await makeBridgeHarness({ storageDir, withAskUser: true })
    harness.onElicitation = () => ({ action: 'accept', content: { custom: 'Use Zig' } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    const result = await harness.ctx.userInteraction.ask({
      agent,
      questions: [{
        id: 'language',
        question: 'Which language?',
        options: [{ label: 'TypeScript' }],
      }],
    })

    expect(result).toEqual({ answers: [{ id: 'language', selected: [], custom: 'Use Zig' }] })
    expect(harness.elicitationRequests[0]).toMatchObject({
      requestedSchema: {
        properties: {
          choice: {
            description: 'Choose one option, or fill a custom answer below.',
            oneOf: [{ const: 'TypeScript', title: 'TypeScript' }],
          },
          custom: { type: 'string' },
        },
        required: [],
      },
    })
  })

  it('treats ACP custom answers as overriding selected choices', async () => {
    harness = await makeBridgeHarness({ storageDir, withAskUser: true })
    harness.onElicitation = () => ({ action: 'accept', content: { choice: 'TypeScript', custom: 'Use Zig' } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    await expect(harness.ctx.userInteraction.ask({
      agent,
      questions: [{
        id: 'language',
        question: 'Which language?',
        options: [{ label: 'TypeScript' }],
      }],
    })).resolves.toEqual({ answers: [{ id: 'language', selected: [], custom: 'Use Zig' }] })
  })

  it('supports ACP multi-select answers', async () => {
    harness = await makeBridgeHarness({ storageDir, withAskUser: true })
    harness.onElicitation = () => ({ action: 'accept', content: { choice: ['Tests', 'Docs'] } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    await expect(harness.ctx.userInteraction.ask({
      agent,
      questions: [{
        id: 'targets',
        question: 'Pick',
        options: [{ label: 'Tests' }, { label: 'Docs' }],
        multiSelect: true,
      }],
    })).resolves.toEqual({ answers: [{ id: 'targets', selected: ['Tests', 'Docs'] }] })
  })

  it('reports ACP ask-user routing and answer failures as structured errors', async () => {
    harness = await makeBridgeHarness({ storageDir, withAskUser: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    await expect(harness.ctx.userInteraction.ask({ questions: [{ id: 'x', question: 'No agent?' }] }))
      .rejects.toMatchObject({ name: 'UserInteractionError', code: 'NO_AGENT' })
    await expect(harness.ctx.userInteraction.ask({ agent: { id: 'other' } as typeof agent, questions: [{ id: 'x', question: 'No session?' }] }))
      .rejects.toMatchObject({ code: 'NO_SESSION' })

    harness.onElicitation = () => ({ action: 'cancel' })
    await expect(harness.ctx.userInteraction.ask({ agent, questions: [{ id: 'x', question: 'Cancel?' }] }))
      .rejects.toMatchObject({ code: 'ASK_CANCELLED' })

    harness.onElicitation = () => ({ action: 'accept', content: {} })
    await expect(harness.ctx.userInteraction.ask({ agent, questions: [{ id: 'x', question: 'Empty?' }] }))
      .rejects.toMatchObject({ code: 'NO_ANSWER' })

    harness.onElicitation = () => { throw new Error('client boom') }
    await expect(harness.ctx.userInteraction.ask({ agent, questions: [{ id: 'x', question: 'Client fails?' }], signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'ASK_FAILED' })
  })

  it('aborts ACP ask-user requests before and while waiting for elicitation', async () => {
    harness = await makeBridgeHarness({ storageDir, withAskUser: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(harness.ctx.userInteraction.ask({ agent, questions: [{ id: 'x', question: 'Already?' }], signal: alreadyAborted.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })

    let abortedReads = 0
    const racingAbort = {
      get aborted() { return abortedReads++ > 0 },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
      onabort: null,
      reason: undefined,
      throwIfAborted() {},
    } as AbortSignal
    await expect(harness.ctx.userInteraction.ask({ agent, questions: [{ id: 'x', question: 'Raced?' }], signal: racingAbort }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })

    let release: ((value: { action: 'accept'; content: { custom: string } }) => void) | undefined
    harness.onElicitation = () => new Promise((resolve) => { release = resolve })
    const pendingAbort = new AbortController()
    const ask = harness.ctx.userInteraction.ask({ agent, questions: [{ id: 'x', question: 'Pending?' }], signal: pendingAbort.signal })
    await new Promise(resolve => setImmediate(resolve))
    pendingAbort.abort()

    await expect(ask).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    release?.({ action: 'accept', content: { custom: 'too late' } })
  })

  it('allows multiple concurrent sessions, each with a distinct id', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const b = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(a.sessionId).toBeTruthy()
    expect(b.sessionId).toBeTruthy()
    expect(a.sessionId).not.toBe(b.sessionId)
    // Both agents are live and independently registered.
    expect(harness.ctx.agents.get(SessionId(a.sessionId))).toBeDefined()
    expect(harness.ctx.agents.get(SessionId(b.sessionId))).toBeDefined()
  })

  it('rejects a non-absolute cwd but accepts any absolute cwd (per-session workspace)', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // Relative cwd is still rejected (it becomes the session header / bash workdir).
    await expect(harness.client.newSession({ cwd: 'relative/path', mcpServers: [] }))
      .rejects.toThrow(/absolute/)
    // An absolute cwd that differs from the server launch dir is now ACCEPTED —
    // the per-session cwd is honored (routed to the bash workdir), so the server
    // no longer has to launch in the workspace.
    const res = await harness.client.newSession({ cwd: '/tmp', mcpServers: [] })
    expect(res.sessionId).toBeTruthy()
    // The session header records that cwd, so its bash tools run there.
    expect(harness.ctx.agents.get(SessionId(res.sessionId))!.session.header.cwd).toBe('/tmp')
  })

  it('rejects non-empty additionalDirectories', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [], additionalDirectories: ['/x'] }))
      .rejects.toThrow(/additionalDirectories/)
  })

  it('rejects an empty prompt without hanging', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '   ' }] }))
      .rejects.toThrow(/empty prompt/)
  })

  it('rejects image content in a prompt (text-only capabilities)', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }],
    })).rejects.toThrow(/text/)
  })

  it('accepts a resource_link prompt by rendering the link into the text sent to the agent', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'fix the bug in' },
        { type: 'resource_link', uri: 'file:///x.ts', name: 'x.ts' },
      ],
    })
    expect(result.stopReason).toBe('end_turn')
    const user = harness.ctx.agents.get(SessionId(sessionId))!.session.events.find(event => event.type === 'user/message')
    expect(JSON.stringify(user)).toContain('resource_link')
  })

  it('rejects a prompt for an unknown session', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.prompt({ sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] }))
      .rejects.toThrow(/unknown session/)
  })

  it('negotiates an unsupported protocol version down to the supported one', async () => {
    harness = await makeBridgeHarness({ storageDir })
    const res = await harness.client.initialize({ protocolVersion: 999, clientCapabilities: {} })
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('a cancel for an unknown/absent session is a silent no-op', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // No session created yet — cancel must not throw.
    await expect(harness.client.cancel({ sessionId: 'nope' })).resolves.toBeUndefined()
  })

  it('authenticate is a no-op (no auth methods advertised)', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.authenticate({ methodId: 'whatever' })).resolves.toBeDefined()
  })

  it('renders the deployment persona into ACP-created agents\' requests', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      script: [textResponse('ok')],
      persona: 'be terse',
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // Create + prompt so the system-prompt plugin's persona section reaches
    // the model request of an agent the BRIDGE created (session/new).
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(harness.adapter.requests[0]?.system).toContain('be terse')
  })
})
