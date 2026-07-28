/** Validated configuration for the E2B PTY backend. */

import z from 'schemastery'

/** Public plugin configuration. */
export interface Config {
  /** Backend registry type. */
  backendType?: string
  /** Initial terminal rows. */
  rows?: number
  /** Initial terminal columns. */
  cols?: number
  /** Maximum retained logical lines. */
  scrollbackLines?: number
  /** Maximum retained UTF-8 bytes. */
  scrollbackMaxBytes?: number
  /** Maximum bytes returned by one read or settled viewport. */
  maxReadBytes?: number
  /** Readiness polling interval. */
  pollIntervalMs?: number
  /** Output silence duration that yields `inferred_idle`. */
  idleSilenceMs?: number
  /** Absolute send and startup wait bound. */
  timeoutMs?: number
  /** Grace before PTY teardown escalates from TERM to KILL. */
  disposeGraceMs?: number
}

/** Configuration after Schemastery defaults. */
export type ResolvedConfig = Required<Config>

/* jscpd:ignore-start -- Loader requires a backend-local schema and load-time diagnostics. */
/** Schemastery config exposed by the plugin. */
export const Config: z<Config> = z.object({
  backendType: z.string().default('shell'),
  rows: z.number().default(40),
  cols: z.number().default(160),
  scrollbackLines: z.number().default(10_000),
  scrollbackMaxBytes: z.number().default(4 * 1024 * 1024),
  maxReadBytes: z.number().default(256 * 1024),
  pollIntervalMs: z.number().default(50),
  idleSilenceMs: z.number().default(3_000),
  timeoutMs: z.number().default(30_000),
  disposeGraceMs: z.number().default(3_000),
})

/**
 * Validate the resolved configuration before publishing the backend.
 * @param config - Schemastery-resolved plugin configuration.
 * @returns Nothing; success narrows every optional field to its resolved value.
 */
export function validateConfig(config: Config): asserts config is ResolvedConfig {
  const resolved = config as ResolvedConfig
  if (resolved.backendType.length === 0) throw new Error('pty-e2b: backendType must be non-empty')
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`pty-e2b: ${name} must be a positive safe integer`)
    }
  }
  if (resolved.maxReadBytes > resolved.scrollbackMaxBytes) {
    throw new Error('pty-e2b: maxReadBytes must not exceed scrollbackMaxBytes')
  }
}
/* jscpd:ignore-end */
