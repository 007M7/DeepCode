# Agent Note: Telemetry anonymous user id ($DSH_HOME/.userid) and the OTel Resource user.id

Status: implemented

English | [中文](2026-07-31-telemetry-anonymous-user-id.zh.md)

## Problem

Session telemetry is mounted by default ([default-mount Note](2026-07-31-web-telemetry-default-mount.md)), but the OTel Resource carried only `service.name`/`service.version` — no user-level identity at all, so the collector could neither aggregate per user nor count active users. The only prior ruling on point was an unimplemented one to derive a user id by hashing the hostname/local IP; the dsh-sdk toolchain keeps its own anonymous id (`$DSH_HOME/telemetry.json`), but that is the launcher feed's private fact, unrelated to the OTel feed. The OTel feed needed an anonymous user identity with clean semantics.

## Decision

`getOrCreateAnonymousUserId()` returns the bare UUID line in `$DSH_HOME/.userid` (resolved by `resolveDshHome`, `$DSH_HOME` > `~/.dsh`), minting and persisting a random UUID v4 on first use; the backend constructor carries it as the Resource's `user.id` (the OTel semconv user attribute), once per export batch. The original implementation lived inside `session-telemetry-otel` because no second real consumer existed. `/feedback` later became that consumer, so [the shared-id decision](../architecture/2026-08-07-shared-feedback-telemetry-user-id.md) moves ownership to `@deepseek-ai/dsh-user-id` without changing the storage, anonymity, concurrency, or loss semantics recorded here. The dsh-sdk launcher telemetry keeps its own anonymous-id store (`telemetry.json`) and remains unrelated.

| Ruling | Value | Rationale |
|---|---|---|
| Id source | Random UUID v4, never derived from the hostname, network address, or git remote | A derived id is reversible, making "anonymous" a fiction |
| Storage form | `.userid`, a bare UUID line plus newline, no JSON wrapper | Identity is a standalone fact, not something filed under one telemetry feed's file name/format |
| IO form | Synchronous IO + a process-lifetime memo keyed by resolved file path | `TelemetryOtel`'s constructor is synchronous (async would reshape plugin loading); one disk touch per process, and mid-run file deletion never affects the running process |
| Concurrent first launch | Settled by an exclusive-create (`wx`) write; the loser rereads the winner's id | Covers common concurrency (a reread landing in the winner's microsecond create-to-write window can still yield one id per process for that run, converging on the persisted value next launch — a telemetry-grade consequence, accepted) |
| Loss semantics | File deleted → next launch mints a fresh id; loss is accepted | An anonymous identity has no recovery value; recoverability demands derivation material, which conflicts with anonymity |
| Write failure | Best-effort: return the in-memory id | Telemetry is never blocked by a read-only home |
| Report position | Resource attribute, not per-record attributes | Once per batch suffices for Resource-dimension aggregation; per-record injection would touch the seam contract and grow the wire |
| semconv dependency | `@opentelemetry/semantic-conventions` is not imported | One string constant does not justify a dependency |
| Home | `@deepseek-ai/dsh-user-id`, shared by the OTel backend and `/feedback` | The second real consumer now exists; direct feedback must not depend on an exporter backend |
| Separate switch | None | Either consumer can create the identity; `DSH_TELEMETRY_DISABLED` stops telemetry reporting but does not disable feedback acknowledgement |

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Hostname/IP-hash-derived id (the prior ruling) | Reversible means not anonymous; the random UUID is semantically clean — the user ruled to supersede |
| user.id on every record's attributes (Claude Code's shape) | Touches the session-telemetry seam contract or injects per record, growing the wire; once per batch on the Resource already aggregates |
| A shared package before `/feedback` needed the id (the first cut) | At that time the only real consumer was the OTel backend; extraction became justified only when direct feedback needed the same correlation id |
| Reusing telemetry.json instead of a new file | The file name/JSON format files the identity under the launcher feed's naming; the OTel feed's identity is a standalone fact |
| AppCLIEntry reading the id and injecting via config patch | Every surface entry needs wiring; a runtime fact inside deployment config conflates the two |
| Housing it in `@deepseek-ai/dsh-paths` | paths is pure path computation with zero IO; a persisting identity capability would pollute the package boundary |

## Consequences

- One `$DSH_HOME` is one stable user in the OTel feed; separate homes are separate users by construction, with no cross-home linking mechanism.
- The OTel feed and `/feedback` share `.userid`; the launcher feed still uses `telemetry.json` and cannot be correlated with them.
- Deleting `.userid` resets the identity (effective next launch); on an unwritable home each process holds its own in-memory id until the home becomes writable.
- The [default-mount Note](2026-07-31-web-telemetry-default-mount.md)'s identity follow-up is closed for the anonymous-user-id part by this decision; hostname/surface dimensions, the redaction rule, and the usage-metrics track remain open.
