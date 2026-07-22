/**
 * OpenTelemetry backend for the DeepSeek Harness telemetry seam.
 *
 * Composes the OTel JS SDK as-is — a `LoggerProvider` with a
 * `BatchLogRecordProcessor` and an OTLP/HTTP log exporter — and maps each
 * record handed over by the seam onto `logger.emit()`. Per the seam's
 * boundary axiom, everything downstream of that call (batching, retry,
 * queueing, loss policy) is the SDK's documented behavior, configured
 * verbatim through the `exporter`/`processor` passthroughs; this package
 * adds no knobs of its own on top of them.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel
 */

import { createRequire } from 'node:module'
import z from 'schemastery'
import type { Context } from 'cordis'
import { Telemetry, TelemetryCoordinator, type TelemetryRecord, type TelemetrySeverity } from '@deepseek-ai/dsh-session-telemetry'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type BatchLogRecordProcessorOptions,
} from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { SeverityNumber, type AnyValue, type Logger } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'

// The package's own manifest is the single source of the instrumentation-scope
// version (same pattern as dsh-llm's attribution identity).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * Plugin configuration: two verbatim SDK option shapes plus nothing else.
 * `exporter.url` is the one field this package validates itself — required,
 * no default, must parse as an `http(s)` URL — because a missing endpoint
 * must fail at plugin load, not at first export.
 */
export interface Config {
  /** Passed verbatim to the SDK's OTLP/HTTP log exporter. */
  exporter?: {
    /** Full logs endpoint (e.g. `https://collector.example.com/v1/logs`). Required; validated at plugin load. */
    url?: string
    /** Extra request headers (auth etc.); owned and sent by the SDK exporter. */
    headers?: Record<string, string>
  }
  /**
   * Passed verbatim to `BatchLogRecordProcessor` (minus the exporter slot,
   * which this plugin fills); the SDK owns and documents these knobs.
   */
  processor?: Omit<BatchLogRecordProcessorOptions, 'exporter'>
}

/**
 * Schemastery validator for {@link Config}; cordis runs it before the plugin
 * starts. Shape-level only — the load-bearing `exporter.url` check lives in
 * the constructor so its error message names the field.
 */
export const Config: z<Config> = z.object({
  exporter: z.object({
    url: z.string(),
    headers: z.dict(z.string()),
  }),
  // Opaque passthrough: the SDK owns this shape and validates its own
  // options; re-declaring them here would violate the boundary axiom.
  processor: z.any(),
})

/** Severity mapping from the seam's three-level vocabulary to OTel severity numbers. */
const SEVERITY: Record<TelemetrySeverity, { severityNumber: SeverityNumber; severityText: string }> = {
  info: { severityNumber: SeverityNumber.INFO, severityText: 'INFO' },
  warn: { severityNumber: SeverityNumber.WARN, severityText: 'WARN' },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' },
}

/**
 * The backend plugin — the only entry a deployment loads. Constructing it
 * wires the SDK pipeline, registers the `telemetry` service (duplicate load
 * throws, cordis' standard duplicate-service behavior), and composes the
 * seam's {@link TelemetryCoordinator}, which installs the capture side onto
 * this fiber.
 */
export class TelemetryOtel extends Telemetry {
  static inject = ['sessions']
  static Config = Config

  private readonly provider: LoggerProvider
  private readonly ledger: Logger
  private readonly ops: Logger

  constructor(ctx: Context, config: Config) {
    super(ctx)
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
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
      }),
      processors: [
        new BatchLogRecordProcessor({
          ...config.processor,
          exporter: new OTLPLogExporter({
            url,
            // App identity travels in the Resource (service.name/version);
            // the transport-level user-agent is the SDK's own, per the axiom.
            // Schemastery fills `headers` with {} before cordis constructs the
            // plugin, so the optional type exists for hand-authors only.
            headers: config.exporter?.headers as Record<string, string>,
          }),
        }),
      ],
    })
    this.ledger = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel', version)
    this.ops = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel/ops', version)
    new TelemetryCoordinator(ctx, this)
  }

  /**
   * Map one seam record onto the SDK logger for its channel — a synchronous
   * enqueue into the batch processor's queue.
   * @param record - the logical record handed over by the coordinator.
   */
  emit(record: TelemetryRecord): void {
    const logger = record.channel === 'ops' ? this.ops : this.ledger
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

  /** Forward the turn-boundary hint to the SDK's flush, fire-and-forget. */
  override flush(): void {
    // Best-effort hint: the SDK resolves forceFlush even when exports fail
    // (failures go to its own diagnostics), and the coordinator stops calling
    // this once the fiber is disposed — a rejection would be SDK drift.
    /* v8 ignore next -- unreachable guard: forceFlush does not reject while the provider is alive */
    void this.provider.forceFlush().catch(() => {})
  }

  /**
   * Delegate disposal to the SDK's shutdown contract: flush the queue and
   * quiesce. Awaited (and error-contained) by the coordinator's disposer.
   * @returns resolves when the SDK pipeline has quiesced.
   */
  shutdown(): Promise<void> {
    return this.provider.shutdown()
  }
}

export default TelemetryOtel
