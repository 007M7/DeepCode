/**
 * Keyless-self-skipping smoke: ship one real session's records to a live
 * OTLP collector named by $DSH_OTLP_E2E_ENDPOINT and require the SDK's
 * shutdown (flush-and-quiesce) to resolve. Skipped without the endpoint so
 * secretless CI stays green — a CI accommodation, not a cost signal.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TelemetryOtel from '../src/index.ts'

describe.skipIf(!process.env.DSH_OTLP_E2E_ENDPOINT)('telemetry-otel e2e (live collector)', () => {
  it('exports a session and quiesces cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(TelemetryOtel, {
      exporter: { url: process.env.DSH_OTLP_E2E_ENDPOINT! },
    })
    const session = ctx.sessions.create(SessionId(`e2e-${Date.now()}`), { meta: {} })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(fiber.dispose()).resolves.not.toThrow()
  })
})
