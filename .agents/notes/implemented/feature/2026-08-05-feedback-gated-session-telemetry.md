# Agent Note: Feedback-gated session telemetry

Status: implemented

English | [中文](2026-08-05-feedback-gated-session-telemetry.zh.md)

## Problem

Session telemetry originally has one mounted behavior: every accepted record enters the reporting backend immediately. Deployments need two stricter policies without replacing the plugin: hold a session's telemetry unless its user records feedback, or disable reporting while still explaining what happens to feedback. The policy must preserve the existing full-export default and the telemetry seam's redaction-before-backend boundary.

## Decision

`@deepseek-ai/dsh-session-telemetry-otel` exposes three uppercase `mode` values:

- `FULL` is the default and preserves immediate delivery to the configured OTel pipeline.
- `FEEDBACK_ONLY` reads the canonical session log when `feedback/record` is appended and hands over the unreleased prefix through that exact event. Records appended after that boundary remain local until another feedback event.
- `DISABLED` constructs no exporter, processor, or logger provider. A `feedback/record` listener prints that nothing is shared and the feedback remains local.

The generic telemetry coordinator owns `live` and `on-demand` capture. Live capture projects, clones, redacts, and hands each event to the backend on the session firehose. On-demand capture registers no continuous capture listeners; `captureSession(session, throughSeq)` reads the canonical log from the handoff cursor through an inclusive boundary, then projects, clones, redacts, and hands over that prefix. The cursor advances only for handed-over records. The [buffer-free replay decision](../simplification/2026-08-06-buffer-free-feedback-telemetry.md) owns why the on-demand path uses the canonical log instead of copied records.

The OTel feedback listener passes the feedback event's sequence to `captureSession()`. `Session.append` commits the event before publishing `session/event`, so replay includes that feedback but cannot extend past its boundary. `exporter.url` is required in `FULL` and `FEEDBACK_ONLY`; `DISABLED` does not validate or use exporter configuration.

## Alternatives considered

**Open a session permanently after its first feedback.** Rejected because later work would be shared without another feedback act and the plugin would need additional open-session state. Releasing one pending prefix per feedback has the smaller state machine and the narrower sharing boundary.

**Retain capture-time redacted records until feedback.** Rejected because it duplicates an unbounded session prefix even though the canonical log already owns the events. It preserves capture-time redaction policy and operational records, but those properties do not justify the memory cost for a mode defined as uploading the session log after feedback.

**Use an unmounted plugin as the disabled state.** That remains the silent opt-out, but it cannot warn when feedback is recorded. The explicit disabled mode lets a deployment keep one configuration shape and communicate that the local feedback did not leave the process.

## Consequences

`FULL` remains source- and wire-compatible with the original default. `FEEDBACK_ONLY` adds no telemetry-owned per-event buffer before feedback; a crash before feedback uploads nothing from that prefix. Replay applies the redaction policy mounted when feedback is recorded and excludes operational records that do not exist in the canonical log. Feedback-only streams therefore carry neither `agent-error` nor `shutdown` records, and shutdown absence is not a crash signal. Each later feedback captures the suffix accumulated since the previous boundary. `DISABLED` can omit `exporter.url`, does no reporting work, and keeps feedback only in the canonical session log.
