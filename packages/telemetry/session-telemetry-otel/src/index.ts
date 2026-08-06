/**
 * OpenTelemetry backend for the DeepSeek Harness telemetry seam.
 *
 * Composes the OTel JS SDK as-is — a `LoggerProvider` with a
 * `BatchLogRecordProcessor` and an OTLP/HTTP log exporter — and maps each
 * record handed over by the seam onto `logger.emit()`. Per the seam's
 * boundary axiom, everything downstream of that call (batching, retry,
 * queueing, loss policy) is the SDK's documented behavior, configured
 * verbatim through the `exporter`/`processor` passthroughs. This package owns
 * only whether capture is live, feedback-triggered from the canonical log, or
 * disabled.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel
 */

import { createRequire } from 'node:module'
import z from 'schemastery'
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-command-feedback'
import {
  Telemetry,
  TelemetryCoordinator,
  type TelemetryCapture,
  type TelemetryRecord,
  type TelemetrySeverity,
} from '@deepseek-ai/dsh-session-telemetry'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type BatchLogRecordProcessorOptions,
} from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { SeverityNumber, type AnyValue, type Logger } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'

// The package's own manifest is the single source of the instrumentation-scope
// version (same pattern as dsh-llm's attribution identity).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Session-sharing policy selected by {@link Config.mode}. */
export enum TelemetryMode {
  FULL = 'FULL',
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** Supported session-sharing policies for runtime configuration validation. */
export const TELEMETRY_MODES = [
  TelemetryMode.FULL,
  TelemetryMode.FEEDBACK_ONLY,
  TelemetryMode.DISABLED,
] as const

const DISABLED_FEEDBACK_WARNING = 'session telemetry is DISABLED; nothing will be shared and this feedback remains local'

/**
 * Plugin configuration: one sharing policy plus two verbatim SDK option
 * shapes. `exporter.url` is required for modes that upload and unused for
 * `DISABLED`.
 */
export interface Config {
  /** Sharing policy; defaults to immediate `FULL` delivery. */
  mode?: TelemetryMode
  /**
   * Passed verbatim to the SDK's OTLP/HTTP log exporter — the complete
   * `OTLPExporterNodeConfigBase` shape (`headers`, `timeoutMillis`,
   * `compression`, `keepAlive`, …), owned and documented by the SDK. `url`
   * is the one field this package requires and validates itself.
   */
  exporter?: OTLPExporterNodeConfigBase & {
    /** Full logs endpoint (e.g. `https://collector.example.com/v1/logs`). Required outside `DISABLED`; validated at load. */
    url?: string
  }
  /**
   * Passed verbatim to `BatchLogRecordProcessor` (minus the exporter slot,
   * which this plugin fills); the SDK owns and documents these knobs.
   */
  processor?: Omit<BatchLogRecordProcessorOptions, 'exporter'>
}

/**
 * Schemastery validator for {@link Config}; cordis runs it before the plugin
 * starts. Shape-level only — the mode-dependent `exporter.url` check lives in
 * the constructor so its error message names the field. Both SDK slots are
 * opaque passthroughs: the SDK owns their shapes and validates its own
 * options; re-declaring them field-by-field here would violate the boundary
 * axiom (and silently drop every field not re-declared).
 */
export const Config: z<Config> = z.object({
  mode: z.union(TELEMETRY_MODES).default(TelemetryMode.FULL),
  exporter: z.any(),
  processor: z.any(),
})

/** Severity mapping from the seam's three-level vocabulary to OTel severity numbers. */
const SEVERITY: Record<TelemetrySeverity, { severityNumber: SeverityNumber; severityText: string }> = {
  info: { severityNumber: SeverityNumber.INFO, severityText: 'INFO' },
  warn: { severityNumber: SeverityNumber.WARN, severityText: 'WARN' },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' },
}

/**
 * The backend plugin — the only entry a deployment loads. It always registers
 * the `telemetry` service (duplicate load throws). Uploading modes wire the SDK
 * pipeline and compose {@link TelemetryCoordinator}; `DISABLED` constructs no
 * SDK state and listens only to warn when recorded feedback stays local.
 */
export class TelemetryOtel extends Telemetry {
  static inject = ['sessions']
  static Config = Config

  private readonly provider: LoggerProvider | undefined
  private readonly ledger: Logger | undefined
  private readonly ops: Logger | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const mode = config.mode ?? TelemetryMode.FULL
    if (mode === TelemetryMode.DISABLED) {
      this.provider = undefined
      this.ledger = undefined
      this.ops = undefined
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'feedback/record') ctx.logger.warn(DISABLED_FEEDBACK_WARNING)
      })
      return
    }

    const url = config.exporter?.url
    if (url === undefined || url.length === 0) {
      throw new Error('session-telemetry-otel: exporter.url is required (the full OTLP logs endpoint)')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Re-thrown as a config error: the only way here is a malformed url string.
      throw new Error(`session-telemetry-otel: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`session-telemetry-otel: exporter.url must be http(s), got ${parsed.protocol}`)
    }
    // The one processor field checked beyond the SDK's own validation: the
    // SDK accepts a non-positive batch size, but its shutdown drain then
    // splices empty batches without consuming the queue — dispose would hang
    // forever with records queued. Misconfiguration fails at load instead.
    const batchSize = config.processor?.maxExportBatchSize
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
      throw new Error(`session-telemetry-otel: processor.maxExportBatchSize must be a positive integer, got ${String(batchSize)}`)
    }
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
      }),
      processors: [
        new BatchLogRecordProcessor({
          ...config.processor,
          // The complete validated exporter object, verbatim: every SDK
          // option (`timeoutMillis`, `compression`, `keepAlive`, …) reaches
          // the exporter — rebuilding selected fields here would silently
          // ignore the rest. App identity travels in the Resource
          // (service.name/version); the transport-level user-agent is the
          // SDK's own, per the axiom.
          exporter: new OTLPLogExporter(config.exporter),
        }),
      ],
    })
    this.ledger = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel', version)
    this.ops = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel/ops', version)
    const capture: TelemetryCapture = mode === TelemetryMode.FULL ? 'live' : 'on-demand'
    const coordinator = new TelemetryCoordinator(ctx, this, capture)
    if (mode === TelemetryMode.FEEDBACK_ONLY) {
      // Session.append commits before publishing `session/event`, so the
      // canonical log already includes this feedback record when replay begins.
      ctx.on('session/event', (session, event) => {
        if (event.type === 'feedback/record') coordinator.captureSession(session, event.seq)
      })
    }
  }

  /**
   * Map one seam record onto the SDK logger for its channel — a synchronous
   * enqueue into the batch processor's queue. Direct calls are no-ops in
   * `DISABLED`, where no coordinator or SDK pipeline exists.
   * @param record - the logical record handed over by the coordinator.
   */
  emit(record: TelemetryRecord): void {
    const logger = record.channel === 'ops' ? this.ops : this.ledger
    if (logger === undefined) return
    logger.emit({
      timestamp: record.time,
      observedTimestamp: record.time,
      ...SEVERITY[record.severity],
      // JSON-serializable by the seam's contract (validated at Session.append),
      // which is exactly the AnyValue subset.
      body: record.body as AnyValue,
      attributes: record.attributes,
    })
  }

  // The seam's optional flush() hint is deliberately NOT implemented. The
  // batch processor exports on its own cadence (`processor.scheduledDelayMillis`,
  // the SDK's documented knob), and this backend is the SDK pipeline's only
  // caller — forwarding the hint to `forceFlush()` was the sole source of
  // concurrent flushes, whose undocumented interactions with shutdown's
  // internal drain (concurrent-flush guard, provider-level flush timeout)
  // silently dropped tail records. Removal history and the revival trigger:
  // the revival Agent Note.

  /**
   * Delegate disposal to the SDK's shutdown contract: drain the queue and
   * quiesce. With no concurrent `forceFlush()` in the process (see above),
   * shutdown's internal drain is complete — everything handed to the SDK
   * before this call is exported before the exporter closes. In `FULL`, that
   * includes dispose-time `shutdown` markers; `FEEDBACK_ONLY` creates no ops
   * records. Awaited (and error-contained) by the coordinator's disposer. A
   * disabled backend resolves immediately.
   * @returns resolves when the SDK pipeline has quiesced.
   */
  shutdown(): Promise<void> {
    return this.provider === undefined ? Promise.resolve() : this.provider.shutdown()
  }
}

export default TelemetryOtel
