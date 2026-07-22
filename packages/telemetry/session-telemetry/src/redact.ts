/**
 * Conservative default redaction for outbound telemetry records.
 *
 * Session-event bodies carry file contents and command output that may embed
 * credentials; nothing may cross the seam to a backend unredacted. This module
 * is the innermost rule set of the `telemetry/redact` waterfall — always
 * applied unless an outer listener deliberately replaces the whole chain. It
 * scrubs credential-SHAPED substrings from every string in the record body,
 * leaving structure (keys, nesting, surrounding prose) intact. The pattern
 * list is a security invariant, deliberately not configurable; deployments
 * add stricter rules by stacking `telemetry/redact` listeners.
 *
 * @module @deepseek-ai/dsh-session-telemetry/redact
 */

import type { TelemetryRecord } from './index.ts'

/** Replacement text substituted for each detected credential-shaped span. */
export const REDACTION_PLACEHOLDER = '[REDACTED]'

/**
 * Well-known credential shapes. A match anywhere inside a body string is
 * replaced; low-signal values (package names, versions, git SHAs, plain URLs)
 * deliberately stay untouched — they are the observability signal.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-(?:ant-)?[A-Za-z0-9_-]{10,}/g, // DeepSeek / OpenAI / Anthropic API keys
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub personal/oauth/server/refresh tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM blocks
  /\b(?<scheme>[a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s:@]+@/g, // URL userinfo credentials
]

/** Replace every known credential shape inside one string. */
function scrub(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTION_PLACEHOLDER)
  }
  return out
}

/**
 * Deep-scrub every string inside a lossless-JSON value, preserving structure.
 * The record body is the coordinator's own `structuredClone` — mutation-free
 * rebuilding keeps the exported copy independent of the canonical log either way.
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = scrubValue(entry)
    return out
  }
  return value
}

/**
 * Apply the conservative default rule set to one record — the innermost
 * `next` of the `telemetry/redact` waterfall. Attribute VALUES are scrubbed
 * alongside the body (identity attributes are seam-built and boring, but
 * `session.cwd` is caller-supplied); attribute keys are seam-owned constants.
 * @param record - the candidate record; not mutated.
 * @returns a redacted copy safe to hand to a backend.
 */
export function applyDefaultRedaction(record: TelemetryRecord): TelemetryRecord {
  const attributes: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(record.attributes)) {
    attributes[key] = typeof value === 'string' ? scrub(value) : value
  }
  return { ...record, attributes, body: scrubValue(record.body) }
}
