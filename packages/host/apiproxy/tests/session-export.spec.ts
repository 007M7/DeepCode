/**
 * session.export host path: the GET download endpoint streams a ZIP whose
 * files are the stored artifacts verbatim (root + optional descendants), and
 * the degenerate compositions fail loudly (missing services → 500, missing
 * root → 404, missing descendant → errored stream).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { unzipSync, strFromU8 } from 'fflate'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
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

function artifact(id: string, parentSession?: SessionId, content?: string): SessionRawArtifact {
  return {
    meta: header(id, parentSession),
    filename: 'session.jsonl',
    content: content ?? `{"type":"session","version":0,"id":"${id}","createdAt":1000}\n{"type":"turn/start","seq":0,"time":2000,"data":{"turn":1}}\n`,
  }
}

function node(id: string, ...descendants: SessionLineageNode[]): SessionLineageNode {
  return { session: { header: header(id, sid('session-root')), live: false, persisted: true }, descendants }
}

/** One durable image object served by the fake attachment store. */
function storedImage(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png') {
  return {
    ref: { attachmentId: sid(id), mediaType, bytes: 4, width: 2, height: 2 } as unknown as ImageAttachmentRef,
    data: new Uint8Array([1, 2, 3, 4]),
  }
}

/** A user/message event line carrying one image reference. */
function imageEventLine(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): string {
  return `{"type":"user/message","seq":1,"time":1000,"data":{"content":[{"type":"image","attachment":{"attachmentId":"${id}","mediaType":"${mediaType}","bytes":4,"width":2,"height":2}}]}}`
}

async function buildApi(
  artifacts: Record<string, SessionRawArtifact>,
  descendants: SessionLineageNode[] = [],
  services: {
    query?: boolean
    persistence?: boolean | 'throw' | 'unsupported'
    attachments?: boolean | ((ref: ImageAttachmentRef) => Promise<ReturnType<typeof storedImage>>)
  } = {},
) {
  const ctx = new Context()
  await ctx.plugin(UserInteractionService)
  const query = services.query ?? true
  const persistence = services.persistence ?? true
  if (query) {
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
  if (persistence) {
    ctx.provide('sessionPersistence', {
      supportsRawArtifacts: persistence !== 'unsupported',
      readRaw: async (id: SessionId) => {
        if (persistence === 'throw') throw new Error('/host/private/session.jsonl')
        return artifacts[id]
      },
    } as never)
  }
  if (services.attachments !== false) {
    const readImage = typeof services.attachments === 'function'
      ? services.attachments
      : async (ref: ImageAttachmentRef) => storedImage(String(ref.attachmentId), ref.mediaType)
    ctx.provide('attachments', {
      imageLimits: {} as never,
      validateImage: async () => {},
      saveImage: async () => { throw new Error('export never saves images') },
      readImage,
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

  it('answers 501 when the persistence backend has no per-session raw artifacts', async () => {
    const api = await buildApi({}, [], { persistence: 'unsupported' })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(501)
    expect(await response.text()).toContain('does not expose per-session raw artifacts')
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

  it('includes media objects referenced by the root log under media/<id>.<ext>', async () => {
    const root = artifact('session-root', undefined, [
      '{"type":"session","version":0,"id":"session-root","createdAt":1000}',
      imageEventLine('img-1'),
    ].join('\n') + '\n')
    const api = await buildApi({ 'session-root': root })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual(['media/img-1.png', 'session.jsonl'])
    expect(files['media/img-1.png']).toEqual(storedImage('img-1').data)
  })

  it('collects media referenced from nested tool results', async () => {
    const nested = '{"type":"assistant/message","seq":2,"time":2000,"data":{"content":[{"type":"tool-result","content":[{"type":"image","attachment":{"attachmentId":"nested-1","mediaType":"image/webp","bytes":4,"width":2,"height":2}}]}]}}'
    const root = artifact('session-root', undefined, [
      '{"type":"session","version":0,"id":"session-root","createdAt":1000}',
      nested,
    ].join('\n') + '\n')
    const api = await buildApi({ 'session-root': root })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual(['media/nested-1.webp', 'session.jsonl'])
  })

  it('scans the wrapped, inserted, and chunk carriers plus non-object content items', async () => {
    const block = (id: string, mediaType: string) =>
      `{"type":"image","attachment":{"attachmentId":"${id}","mediaType":"${mediaType}","bytes":4,"width":2,"height":2}}`
    const wrapped = `{"type":"assistant/message","seq":2,"time":2000,"data":{"message":{"role":"assistant","content":["noise",${block('wrapped-1', 'image/jpeg')}]}}}`
    const inserted = `{"type":"context/inserted","seq":3,"time":3000,"data":{"inserted":[{"content":[${block('inserted-1', 'image/gif')}]}]}}`
    const chunk = `{"type":"assistant/chunk","seq":4,"time":4000,"data":{"chunk":{"type":"block-end","block":${block('chunk-1', 'image/png')}}}}`
    const root = artifact('session-root', undefined, [
      '{"type":"session","version":0,"id":"session-root","createdAt":1000}',
      wrapped,
      inserted,
      chunk,
    ].join('\n') + '\n')
    const api = await buildApi({ 'session-root': root })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      'media/chunk-1.png',
      'media/inserted-1.gif',
      'media/wrapped-1.jpg',
      'session.jsonl',
    ])
  })

  it('deduplicates one media object referenced by several included logs', async () => {
    const line = imageEventLine('shared-img')
    const root = artifact('session-root', undefined, [
      '{"type":"session","version":0,"id":"session-root","createdAt":1000}',
      line,
    ].join('\n') + '\n')
    const child = artifact('child-a', sid('session-root'), [
      '{"type":"session","version":0,"id":"child-a","createdAt":1000}',
      line,
    ].join('\n') + '\n')
    const api = await buildApi({ 'session-root': root, 'child-a': child }, [node('child-a')])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(files['media/shared-img.png']).toEqual(storedImage('shared-img').data)
    expect(Object.keys(files).filter(name => name.startsWith('media/'))).toEqual(['media/shared-img.png'])
  })

  it('includes descendant media only when descendants are requested', async () => {
    const child = artifact('child-a', sid('session-root'), [
      '{"type":"session","version":0,"id":"child-a","createdAt":1000}',
      imageEventLine('child-img'),
    ].join('\n') + '\n')
    const api = await buildApi({ 'session-root': artifact('session-root'), 'child-a': child }, [node('child-a')])
    const without = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(Object.keys(unzipSync(await responseBytes(without)))).toEqual(['session.jsonl'])
    const withDescendants = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    expect(Object.keys(unzipSync(await responseBytes(withDescendants))).sort()).toEqual([
      'media/child-img.png',
      'session.jsonl',
      'subagents/child-a/session.jsonl',
    ])
  })

  it('fails the whole export when a referenced image cannot be read', async () => {
    const root = artifact('session-root', undefined, [
      '{"type":"session","version":0,"id":"session-root","createdAt":1000}',
      imageEventLine('gone-img'),
    ].join('\n') + '\n')
    const api = await buildApi({ 'session-root': root }, [], {
      attachments: async () => { throw new Error('attachment bytes missing') },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('attachment bytes missing')
  })

  it('answers 500 when the deployment mounts no attachments service', async () => {
    const api = await buildApi({ 'session-root': artifact('session-root') }, [], { attachments: false })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('attachments')
  })
})
