# Agent Note: Shared feedback and telemetry anonymous user id

Status: implemented

English | [中文](2026-08-07-shared-feedback-telemetry-user-id.zh.md)

## Problem

The OpenTelemetry backend already persisted one anonymous UUID in `$DSH_HOME/.userid`. `/feedback` now needs to report both the receiving session id and a user id so an operator can correlate the acknowledgement with exported records. Duplicating or independently generating that identity would make the reported user meaningless, while importing it from `session-telemetry-otel` would make a direct command depend on an exporter backend and create a dependency cycle when feedback export is mounted by telemetry.

The earlier [anonymous-user-id decision](../feature/2026-07-31-telemetry-anonymous-user-id.md) deliberately kept the helper inside the OTel backend until a second real consumer existed. Feedback is that consumer.

## Decision

`@deepseek-ai/dsh-user-id` owns `getOrCreateAnonymousUserId()` and the `$DSH_HOME/.userid` storage contract. `session-telemetry-otel` uses the returned id as OpenTelemetry Resource `user.id`; the `/feedback` success acknowledgement reports `Feedback recorded for session {sessionId}` followed by `User: {userId}` on a second line, which keeps both identifiers available through the generic command row's expandable body. Invalid feedback is rejected before resolving the id, so an empty command does not create `.userid`.

The extraction preserves the existing random UUID, home resolution, process memo, exclusive-create concurrency, corruption replacement, and best-effort write semantics. It does not unify the dsh-sdk launcher's separate `telemetry.json` identity.

## Alternatives considered

| Rejected | Reason |
|---|---|
| Import the helper from `session-telemetry-otel` | Couples feedback to an optional exporter backend and forms a reverse dependency cycle once telemetry exports feedback |
| Duplicate the persistence helper in feedback | Two implementations of one file contract can drift and race with different validation or failure semantics |
| Generate a separate feedback user id | The acknowledgement could not correlate with the OTel Resource and would not satisfy the reporting purpose |
| Move the launcher telemetry id too | The launcher feed is not a consumer of `.userid`; unifying unrelated stores remains out of scope |

## Consequences

- One harness home now has one anonymous id shared by feedback acknowledgements and session telemetry exports.
- The feedback package depends only on the identity capability, not the telemetry seam or OTel SDK.
- The new package is a justified shared seam with two consumers; its empty invariant companion explains why reading the private file is not a useful runtime relationship check.
- The original anonymous-user-id Note remains authoritative for storage and privacy semantics, while this Note supersedes only its OTel-local ownership decision.
