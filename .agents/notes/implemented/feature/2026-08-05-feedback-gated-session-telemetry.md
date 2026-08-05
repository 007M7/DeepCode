# Agent Note: Feedback-gated session telemetry

Status: implemented

English | [中文](2026-08-05-feedback-gated-session-telemetry.zh.md)

## Problem

Session telemetry originally has one mounted behavior: every accepted record enters the reporting backend immediately. Deployments need two stricter policies without replacing the plugin: hold a session's telemetry unless its user records feedback, or disable reporting while still explaining what happens to feedback. The policy must preserve the existing full-export default and the telemetry seam's redaction-before-backend boundary.

## Decision

`@deepseek-ai/dsh-session-telemetry-otel` exposes three uppercase `mode` values:

- `FULL` is the default and preserves immediate delivery to the configured OTel pipeline.
- `FEEDBACK_ONLY` captures redacted copies in memory and releases the pending session prefix when `feedback/record` is appended. The released prefix includes the feedback event itself. Records appended after that event form another withheld prefix until another feedback event releases them.
- `DISABLED` constructs no exporter, processor, or logger provider. A `feedback/record` listener prints that nothing is shared and the feedback remains local.

The generic telemetry coordinator owns the delivery distinction as `immediate` or `held`. Both paths project, clone, and run `telemetry/record` listeners at capture time. Immediate delivery sends the accepted record to the backend and advances the session's handoff cursor. Held delivery retains the accepted record per session without moving that cursor. `release(session)` submits the retained records in order, contains each backend failure independently, advances the cursor only for submitted records, and removes the released prefix.

The OTel feedback listener is registered after the coordinator's session listener. Cordis therefore gives the coordinator the feedback append first, then the OTel listener releases a prefix that already contains that event. `exporter.url` is required in `FULL` and `FEEDBACK_ONLY`; `DISABLED` does not validate or use exporter configuration.

## Alternatives considered

**Open a session permanently after its first feedback.** Rejected because later work would be shared without another feedback act and the plugin would need additional open-session state. Releasing one pending prefix per feedback has the smaller state machine and the narrower sharing boundary.

**Buffer after `TelemetryCoordinator.emit()` in the OTel backend.** Rejected because the coordinator would advance its handoff cursor before a record became eligible for upload. A plugin rebuild would then lose the only retained copy and incorrectly treat the prefix as handed off.

**Replay the canonical session log when feedback arrives.** Rejected because replay would repeat projection and redaction, exclude telemetry operation records that are not session events, and require more lifecycle state to distinguish previously released prefixes.

**Use an unmounted plugin as the disabled state.** That remains the silent opt-out, but it cannot warn when feedback is recorded. The explicit disabled mode lets a deployment keep one configuration shape and communicate that the local feedback did not leave the process.

## Consequences

`FULL` remains source- and wire-compatible with the original default. `FEEDBACK_ONLY` retains deep-copied, already-redacted records in process memory until feedback or session collection; a crash before release uploads nothing from that prefix. A clean shutdown after the last feedback is part of the new withheld suffix, so feedback-only streams do not carry a reliable shutdown or crash signal. Each later feedback releases the suffix accumulated since the previous one. `DISABLED` can omit `exporter.url`, does no reporting work, and keeps feedback only in the canonical session log.
