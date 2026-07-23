# Agent Note: Session telemetry seam with mandatory redaction and the OTel backend

Status: implemented

English | [中文](2026-07-23-session-telemetry-otel-revival.zh.md)

## Problem

Every deployment that wants harness sessions in an observability stack must hand-roll a session-log consumer: subscription, lifecycle handoff, and — hardest — redaction, since the raw log carries file contents and command output that may embed credentials. A telemetry seam and OTel backend shipped once on the `session-telemetry-otlp-rfc` branch (PR #222/#231) but never reached master: the proposal exported raw session events verbatim, which legal review declined. The capture-side design (backend contract, coordinator, handoff cursor, chunk projection) was sound and reviewed; the export-side stance was the blocker.

## Decision

`packages/telemetry/` revives the two reviewed packages under the SDK stance — the harness provides the capability, the deployment configures where records go and owns what leaves in them:

- **`@deepseek-ai/dsh-session-telemetry`** — the seam. `TelemetryBackend` (`emit`/`flush?`/`shutdown`), the service-registered `Telemetry` form, and `TelemetryCoordinator` owning capture: adoption with cursor read-back, the per-append firehose (project → `structuredClone` → redact → `emit`, zero I/O), the fixed first-chunk-per-(turn, step) projection, the `agent/error` relay, and dispose-time `shutdown` records.
- **The `telemetry/redact` waterfall** — the delta over the branch version. Every record passes it before reaching any backend; the seam ships NO rules of its own — the innermost `next()` is a pass-through, deployments mount their rules as listeners (stacking by transforming `next()`'s return value), and a throwing rule withholds the record fail-closed. Redaction applies to the exported copy only; the canonical log is never rewritten.
- **`@deepseek-ai/dsh-session-telemetry-otel`** — the reference backend: OTel JS SDK log pipeline (`LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP exporter), configured verbatim through `exporter`/`processor` passthroughs. `exporter.url` is required and validated at load; unmounted or unconfigured, nothing leaves the process.

The boundary axiom holds: the harness's aspect ends at `emit()`. Batching, retry, queueing, and loss policy are the reporting SDK's, configured through passthroughs — delivery is best-effort (at-most-once across a crash), which the READMEs state plainly.

## Alternatives considered

**Implement the runtime-telemetry RFC's outbox (durable spool, per-sink cursors, at-least-once, a `readCommitted` persistence-seam method).** Deferred, not rejected: the SDK stance makes delivery semantics the reporting SDK's territory, and the OTel SDK's own batch pipeline is the honest default. The outbox is a pure additive layer (the `emit()` contract does not move); revive it when a deployment states a crash-loss requirement telemetry must satisfy.

**No in-process redaction point, delegating to receiver-side collector processors.** Rejected — receiver-side redaction ships the secret first and scrubs it second. The waterfall puts an auditable, stackable scrubbing point before bytes leave the process; where the branch version (what PR #222 shipped) had no redaction point at all, every record now passes one.

**A built-in conservative rule set as the waterfall's innermost `next()`.** Rejected: as an SDK we cannot know which patterns are secrets in a given deployment, a shipped list invites false confidence ("redaction is on") while catching only known shapes, and false positives would corrupt exported bodies for consumers who never asked. The seam owns the mechanism; the deployment owns the policy — the innermost `next()` is a pass-through, and rules mount as listeners.

**Map onto OTel spans (GenAI semantic conventions) instead of logs.** Rejected for this revival: the branch implementation's log mapping is reviewed and shipped-shaped; the span model is lossy for forkable, interruptible sessions and belongs to a future consumer with real span queries to serve.

## Consequences

A deployment adds one `cordis.yml` entry with an OTLP endpoint and gets its session stream in any OTel-compatible stack; removing the entry is the opt-out, with no residual state. A rule-free deployment exports records exactly as captured — including any credentials embedded in file contents or command output — so a deployment crossing a trust boundary must mount `telemetry/redact` listeners, and both READMEs state this plainly. Where rules are mounted, exported bodies can differ from canonical log bytes, so receivers must not treat telemetry as a byte-exact replica; the log remains the source of truth. Crash durability is explicitly out of scope until the outbox decision above is revisited.
