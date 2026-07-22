import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { encodeSessionReferenceUri } from '@deepseek-ai/dsh-session-reference'
import { ACP_SESSION_REFERENCE_META_KEY } from '../src/index.ts'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('acp bridge — session/list', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-list-')) })
  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('advertises title-aware listing and reference metadata for loadable sessions', async () => {
    harness = await makeBridgeHarness({ storageDir, withSessionReferences: true })
    const initialized = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(initialized.agentCapabilities?.sessionCapabilities?.list).toEqual({})

    const cwd = process.cwd()
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    const session = harness.ctx.agents.get(SessionId(sessionId))!.session
    await harness.ctx.sessions.appendOutOfBand(session, 'session/title', {
      title: 'Reference source title',
      messageSeqs: [],
      source: { kind: 'fallback' },
    }, { kind: 'session-title' })
    harness.ctx.sessions.create(SessionId('untitled'), { meta: { cwd: join(storageDir, 'other') } })
    harness.ctx.sessions.create(SessionId('missing-cwd'))

    const listed = await harness.client.listSessions({})
    expect(listed.nextCursor).toBeUndefined()
    expect(listed.sessions.map(item => item.sessionId)).toEqual(expect.arrayContaining([sessionId, 'untitled']))
    expect(listed.sessions.map(item => item.sessionId)).not.toContain('missing-cwd')
    const source = listed.sessions.find(item => item.sessionId === sessionId)
    expect(source).toMatchObject({ cwd, title: 'Reference source title' })
    expect(source?._meta?.[ACP_SESSION_REFERENCE_META_KEY]).toEqual({
      uri: encodeSessionReferenceUri(SessionId(sessionId)),
    })
    expect(listed.sessions.find(item => item.sessionId === 'untitled')).not.toHaveProperty('title')
  })

  it('filters by normalized cwd and omits reference metadata without the optional capability', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const firstCwd = join(storageDir, 'first')
    const secondCwd = join(storageDir, 'second')
    const first = await harness.client.newSession({ cwd: firstCwd, mcpServers: [] })
    await harness.client.newSession({ cwd: secondCwd, mcpServers: [] })

    const listed = await harness.client.listSessions({ cursor: null, cwd: firstCwd })
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({ sessionId: first.sessionId, cwd: firstCwd })
    expect(listed.sessions[0]?._meta).toBeUndefined()
    await expect(harness.client.listSessions({ cwd: null })).resolves.toHaveProperty('sessions')
  })

  it('rejects unsupported cursors and relative cwd filters', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.listSessions({ cursor: 'next' })).rejects.toThrow('session/list does not paginate')
    await expect(harness.client.listSessions({ cwd: 'relative' })).rejects.toThrow('session/list cwd must be absolute')
  })

  it('folds titles from persisted sessions in a fresh bridge', async () => {
    harness = await makeBridgeHarness({ storageDir, withSessionReferences: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const cwd = process.cwd()
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    const session = harness.ctx.agents.get(SessionId(sessionId))!.session
    await harness.ctx.sessions.appendOutOfBand(session, 'session/title', {
      title: 'Persisted reference title',
      messageSeqs: [],
      source: { kind: 'fallback' },
    }, { kind: 'session-title' })
    await harness.dispose()

    harness = await makeBridgeHarness({ storageDir, withSessionReferences: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.listSessions({ cwd })).resolves.toMatchObject({
      sessions: [{ sessionId, cwd, title: 'Persisted reference title' }],
    })
  })
})
