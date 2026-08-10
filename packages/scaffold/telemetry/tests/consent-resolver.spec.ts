import { describe, expect, it } from 'vitest'
import {
  resolveTelemetryConsent,
  type ConsentDecision,
} from '@deepseek-ai/dsh-telemetry'

describe('resolveTelemetryConsent', () => {
  it('denies launcher telemetry when the shared mode is unset or empty', () => {
    expect(resolveTelemetryConsent({})).toEqual<ConsentDecision>({ allowed: false, reason: 'DISABLED' })
    expect(resolveTelemetryConsent({ DSH_TELEMETRY_MODE: '' }))
      .toEqual<ConsentDecision>({ allowed: false, reason: 'DISABLED' })
  })

  it('denies launcher telemetry in DISABLED and FEEDBACK_ONLY modes', () => {
    expect(resolveTelemetryConsent({ DSH_TELEMETRY_MODE: 'DISABLED' }))
      .toEqual<ConsentDecision>({ allowed: false, reason: 'DISABLED' })
    expect(resolveTelemetryConsent({ DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' }))
      .toEqual<ConsentDecision>({ allowed: false, reason: 'FEEDBACK_ONLY' })
  })

  it('allows launcher telemetry only in FULL mode', () => {
    expect(resolveTelemetryConsent({ DSH_TELEMETRY_MODE: 'FULL' }))
      .toEqual<ConsentDecision>({ allowed: true, reason: 'FULL' })
  })

  it('rejects an unsupported non-empty mode', () => {
    expect(() => resolveTelemetryConsent({ DSH_TELEMETRY_MODE: 'full' }))
      .toThrow('unsupported DSH_TELEMETRY_MODE "full"')
  })

  it('reads process.env by default', () => {
    const saved = process.env.DSH_TELEMETRY_MODE
    process.env.DSH_TELEMETRY_MODE = 'FULL'
    try {
      expect(resolveTelemetryConsent()).toEqual<ConsentDecision>({ allowed: true, reason: 'FULL' })
    } finally {
      if (saved === undefined) delete process.env.DSH_TELEMETRY_MODE
      else process.env.DSH_TELEMETRY_MODE = saved
    }
  })
})
