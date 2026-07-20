import { describe, expect, it } from 'vitest'
import { SecretRedactor } from '../src/secret-redactor.ts'
import { telemetryRedactionViolation } from '../src/redaction-contract.ts'

describe('telemetryRedactionViolation', () => {
  it('accepts the shipped redactor and rejects one that preserves credentials', () => {
    expect(telemetryRedactionViolation(
      new SecretRedactor(),
      '[REDACTED]',
      '@deepseek-ai/dsh-telemetry',
    )).toBeUndefined()
    expect(telemetryRedactionViolation(
      { redactText: value => value },
      '[REDACTED]',
      '@deepseek-ai/dsh-telemetry',
    )).toBe('telemetry redaction must remove credential values, preserve package metadata, and remain idempotent')
  })
})
