import { describe, expect, it } from 'vitest'
import { resolveTelemetryPatch } from '../src/app-cli-entry.ts'

describe('resolveTelemetryPatch', () => {
  it('keeps telemetry enabled when the switch is unset or empty', () => {
    expect(resolveTelemetryPatch(undefined, true)).toBeUndefined()
    expect(resolveTelemetryPatch('', true)).toBeUndefined()
  })

  it('disables on ANY non-empty value, including falsy-looking ones', () => {
    for (const value of ['1', '0', 'false', 'no']) {
      expect(resolveTelemetryPatch(value, true)).toEqual({ id: 'telemetry-otel', disabled: true })
    }
  })

  it('fails loud when the switch is set but the row is absent', () => {
    expect(() => resolveTelemetryPatch('1', false)).toThrow('DSH_TELEMETRY_DISABLED is set but row "telemetry-otel" is not in this composition')
  })

  it('ignores a missing row while the switch is unset', () => {
    expect(resolveTelemetryPatch(undefined, false)).toBeUndefined()
  })
})
