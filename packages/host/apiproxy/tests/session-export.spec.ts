/**
 * session.export host path: the GET download endpoint streams a ZIP whose
 * files are the stored artifacts verbatim (root + optional descendants), and
 * the degenerate compositions fail loudly (missing services → 500, missing
 * root → 404, missing descendant → errored stream).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { unzipSync, strFromU8 } from 'fflate'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import type { SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

function header(id: string, parentSession?: SessionId): SessionHeader {
  return {
    version: 0,
    id: sid(id),
    createdAt: 1000,
    cwd: '/proj',
    ...parentSession === undefined ? {} : { parentSession },
    delegationDepth: parentSession === undefined ? 0 : 1,
  }
}

function artifact(id: string, parentSession?: SessionId): SessionRawArtifact {
  return {
    meta: header(id, parentSession),
    filename: 'session.jsonl',
    content: `{"type":"session","version":0,"id":"${id}","createdAt":1000}\n{"type":"turn/start","seq":0,"time":2000,"data":{"turn":1}}\n`,
  }
}

function node(id: string, ...descendants: SessionLineageNode[]): SessionLineageNode {
  return { session: { header: header(id, sid('session-root')), live: false, persisted: true }, descendants }
}

async function buildApi(
  artifacts: Record<string, SessionRawArtifact>,
  descendants: SessionLineageNode[] = [],
  services: { query?: boolean; persistence?: boolean | 'throw' } = { query: true, persistence: true },
) {
  const ctx = new Context()
  await ctx.plugin(UserInteractionService)
  if (services.query) {
    ctx.provide('sessionQuery', {
      traceSession: async () => ({
        target: { header: header('session-root'), live: false, persisted: true },
        ancestors: [],
        complete: true,
        root: { header: header('session-root'), live: false, persisted: true },
        descendants,
      }),
    } as never)
  }
  if (services.persistence) {
    ctx.provide('sessionPersistence', {
      readRaw: async (id: SessionId) => {
        if (services.persistence === 'throw') throw new Error('/host/private/session.jsonl')
        return artifacts[id]
      },
    } as never)
  }
  return createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

describe('session.export download endpoint', () => {
  it('streams a ZIP with the root artifact verbatim under its original filename', async () => {
    const api = await buildApi({ 'session-root': artifact('session-root') })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('dsh-session-session-root.zip')
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files)).toEqual(['session.jsonl'])
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toBe(artifact('session-root').content)
  })

  it('includes descendant artifacts under subagents/<id>/ when requested', async () => {
    const api = await buildApi({
      'session-root': artifact('session-root'),
      'child-a': artifact('child-a', sid('session-root')),
      'grandchild-a': artifact('grandchild-a', sid('child-a')),
    }, [
      node('child-a', node('grandchild-a')),
    ])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      'session.jsonl',
      'subagents/child-a/session.jsonl',
      'subagents/grandchild-a/session.jsonl',
    ])
    expect(strFromU8(files['subagents/child-a/session.jsonl'] as Uint8Array))
      .toBe(artifact('child-a').content)
  })

  it('answers 404 for a missing root session', async () => {
    const api = await buildApi({})
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(404)
  })

  it('answers 400 when the sessionId query parameter is absent', async () => {
    const api = await buildApi({ 'session-root': artifact('session-root') })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?includeDescendants=true'),
    )
    expect(response.status).toBe(400)
  })

  it('answers 400 for an includeDescendants value other than true or false', async () => {
    const api = await buildApi({ 'session-root': artifact('session-root') })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=1'),
    )
    expect(response.status).toBe(400)
  })

  it('answers 500 when the deployment mounts no persistence or session-query service', async () => {
    const api = await buildApi({}, [], { query: false, persistence: false })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('session-query')
  })

  it('fails the whole export when a descendant has no stored artifact', async () => {
    const api = await buildApi({
      'session-root': artifact('session-root'),
    }, [node('child-missing')])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    expect(response.status).toBe(200)
    // The stream errors before completing, so the body read rejects rather
    // than returning a truncated-but-valid archive.
    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  it('keeps an astral character whole when its surrogate pair straddles a push boundary', async () => {
    // The push loop slices by 2^16 code units and must back off one unit when
    // the boundary lands inside a surrogate pair; otherwise the pair re-encodes
    // as U+FFFD and the exported artifact is silently corrupted.
    const root = { ...artifact('session-root'), content: `${'a'.repeat((1 << 16) - 1)}😀tail` }
    const api = await buildApi({ 'session-root': root })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toBe(root.content)
  })

  it('splits a long artifact on a plain code-unit boundary without backoff', async () => {
    // A boundary that lands on a BMP character needs no surrogate backoff; the
    // round trip must still be byte-identical across the multi-chunk push.
    const root = { ...artifact('session-root'), content: 'z'.repeat((1 << 16) + 4096) }
    const api = await buildApi({ 'session-root': root })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toBe(root.content)
  })

  it('exports an empty artifact as an empty zip entry', async () => {
    const root = { ...artifact('session-root'), content: '' }
    const api = await buildApi({ 'session-root': root })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files)).toEqual(['session.jsonl'])
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toBe('')
  })

  it('exports a shared lineage node once (seen-set dedup)', async () => {
    const api = await buildApi({
      'session-root': artifact('session-root'),
      'child-a': artifact('child-a', sid('session-root')),
      'child-b': artifact('child-b', sid('session-root')),
      shared: artifact('shared', sid('child-a')),
    }, [
      node('child-a', node('shared')),
      node('child-b', node('shared')),
    ])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      'session.jsonl',
      'subagents/child-a/session.jsonl',
      'subagents/child-b/session.jsonl',
      'subagents/shared/session.jsonl',
    ])
  })

  it('answers 500 without leaking the backend error when the root artifact read fails', async () => {
    const api = await buildApi({}, [], { query: true, persistence: 'throw' })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe('session log export failed to read the stored artifact')
    expect(body).not.toContain('/host/private/')
  })
})
