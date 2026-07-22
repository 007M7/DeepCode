/**
 * OTel backend unit tier: wire assertions against a scripted `node:http`
 * mock collector through the SDK's REAL pipeline (BatchLogRecordProcessor →
 * OTLP/HTTP JSON), config fail-loud cases, and the real-Loader-path guard
 * for the default-exported Service class.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TelemetryOtel, { Config } from '../src/index.ts'

interface Capture {
  headers: import('node:http').IncomingHttpHeaders
  body: OtlpLogsRequest
}

/** Just the slice of ExportLogsServiceRequest JSON these assertions touch. */
interface OtlpLogsRequest {
  resourceLogs: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] }
    scopeLogs: {
      scope: { name: string }
      logRecords: {
        timeUnixNano: string
        severityNumber: number
        severityText: string
        attributes?: { key: string; value: Record<string, unknown> }[]
      }[]
    }[]
  }[]
}

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close()
    server.closeAllConnections()
  }
})

async function mockCollector(): Promise<{ url: string; captures: Capture[] }> {
  const captures: Capture[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      captures.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()) as OtlpLogsRequest,
      })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}/v1/logs`, captures }
}

async function boot(url: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(TelemetryOtel, {
    exporter: { url, headers: { authorization: 'Bearer test-token' } },
  })
  return { ctx, fiber }
}

function allRecords(captures: Capture[]) {
  return captures.flatMap(c => c.body.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s =>
    s.logRecords.map(record => ({ scope: s.scope.name, record })))))
}

describe('TelemetryOtel wire', () => {
  it('ships session records and the ops shutdown marker through the real SDK pipeline', async () => {
    const { url, captures } = await mockCollector()
    const { ctx, fiber } = await boot(url)
    const session = ctx.sessions.create(SessionId('wire'), { meta: { cwd: '/tmp/w' } })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'boom' } })
    await fiber.dispose()

    expect(captures.length).toBeGreaterThan(0)
    const first = captures[0]!
    const authorization: string | undefined = first.headers.authorization
    expect(authorization).toBe('Bearer test-token')

    const resource = first.body.resourceLogs[0]!.resource.attributes
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'deepseek-harness' } })

    const records = allRecords(captures)
    const ledger = records.filter(r => r.scope === '@deepseek-ai/dsh-session-telemetry-otel')
    const ops = records.filter(r => r.scope === '@deepseek-ai/dsh-session-telemetry-otel/ops')

    const start = ledger.find(r => r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'turn/start'))
    expect(start).toBeDefined()
    expect(start?.record.severityNumber).toBe(9)
    expect(BigInt(start!.record.timeUnixNano)).toBe(BigInt(session.events[0]!.time) * 1_000_000n)
    expect(start?.record.attributes).toContainEqual({ key: 'session.cwd', value: { stringValue: '/tmp/w' } })

    const end = ledger.find(r => r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'turn/end'))
    expect(end?.record.severityNumber).toBe(17)
    expect(end?.record.severityText).toBe('ERROR')

    expect(ops).toHaveLength(1)
    expect(ops[0]!.record.attributes).toContainEqual({ key: 'telemetry.op', value: { stringValue: 'shutdown' } })
  })

  it('maps the warn severity and forwards the flush hint to the SDK', async () => {
    const { url, captures } = await mockCollector()
    const { ctx, fiber } = await boot(url)
    const session = ctx.sessions.create(SessionId('warn'), { meta: {} })
    session.append('prompt/blocked', { content: [], source: { kind: 'user' }, reason: 'vetoed' })
    // The turn-boundary hint: safe, non-blocking, and enough to push the batch out.
    expect(() => {
      ctx.telemetry.flush!()
    }).not.toThrow()
    await fiber.dispose()
    const blocked = allRecords(captures).find(r =>
      r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'prompt/blocked'))
    expect(blocked?.record.severityNumber).toBe(13)
  })
})

describe('TelemetryOtel config fails loud', () => {
  it.each([
    [{}, /exporter\.url is required/],
    [{ exporter: { url: '' } }, /exporter\.url is required/],
    [{ exporter: { url: 'not a url' } }, /not a valid URL/],
    [{ exporter: { url: 'ftp://collector' } }, /must be http\(s\)/],
  ])('rejects %j at plugin load', async (config, message) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(TelemetryOtel, config as Config)).rejects.toThrow(message)
  })
})

describe('dsh-session-telemetry-otel real-load-path guard', () => {
  it('keeps the Service class with inject/Config through unwrapExports', async () => {
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as typeof TelemetryOtel
    expect(unwrapped).toBe(TelemetryOtel)
    expect(unwrapped.inject).toEqual(['sessions'])
    expect(typeof unwrapped.Config).toBe('function')
  })

  it('boots through the unwrapped class and registers ctx.telemetry', async () => {
    const { url } = await mockCollector()
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as Parameters<Context['plugin']>[0]
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(unwrapped, { exporter: { url } })
    expect(ctx.telemetry).toBeInstanceOf(TelemetryOtel)
    await fiber.dispose()
  })
})
