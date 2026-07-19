/** Structural redactor surface sampled by the telemetry invariant. */
export interface TelemetryRedactionBoundary {
  /** Redact credential material in free-form telemetry content. */
  redactText(value: string): string
}

/**
 * Validate the security-critical telemetry redaction boundary.
 * @param redactor - candidate content redactor.
 * @param placeholder - expected replacement for a secret value.
 * @param packageName - ordinary package metadata that must survive redaction.
 * @returns the violated contract, or `undefined` when redaction is safe and idempotent.
 */
export function telemetryRedactionViolation(
  redactor: TelemetryRedactionBoundary,
  placeholder: string,
  packageName: string,
): string | undefined {
  const secret = 'sk-abcdefghij1234567890'
  const redacted = redactor.redactText(`apiKey: ${secret}\nname: ${packageName}\n`)
  return !redacted.includes(secret)
    && redacted.includes(`apiKey: ${placeholder}`)
    && redacted.includes(`name: ${packageName}`)
    && redactor.redactText(redacted) === redacted
    ? undefined
    : 'telemetry redaction must remove credential values, preserve package metadata, and remain idempotent'
}
