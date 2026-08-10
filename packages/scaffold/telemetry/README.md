# `@deepseek-ai/dsh-telemetry`

English | [中文](README.zh.md)

Launcher-side telemetry primitives for the dsh-sdk toolchain. This is a plain library the launcher imports around each command; it is not a Cordis plugin because `build` and first-init `create` never boot Cordis. Wiring the reporter into launcher command dispatch lives in its owning package.

| Export | Role |
|---|---|
| `SecretRedactor` | Conservative safety backstop: replaces secret-shaped values (secret-like keys, known token shapes, PEM blocks, URL credentials, high-entropy opaque tokens) with a placeholder in both parsed values (`redactValue`) and raw text (`redactText`). Never drops a field or line. |
| `resolveTelemetryConsent` | Reads the shared `DSH_TELEMETRY_MODE`; only `FULL` permits launcher reporting, while `FEEDBACK_ONLY`, `DISABLED`, unset, and empty values deny it. |
| `buildTelemetryPayload` | Assembles `{command, durationMs, success, cordisYmlContent, packageJsonContent}`, running the redactor over the full `cordis.yml` and `package.json` text. Never reads `.env`; `package.json` ships only alongside a `cordis.yml`, so a command run in a non-SDK directory never uploads that directory's unrelated manifest. |
| `getOrCreateAnonymousId` | Random UUID persisted in the harness home resolved by [`@deepseek-ai/dsh-paths`](../../util/paths/README.md) (`$DSH_HOME` > `~/.dsh`), scoped to that home rather than the machine, never derived from git. |
| `TelemetryReporter` | Fire-and-forget send: `report()` never blocks or throws; delivery resolves on every path; `flush()` optionally drains in-flight sends within a cap. |

`DSH_TELEMETRY_MODE` is the single positive consent setting for session and launcher telemetry. `FULL` enables this launcher feed; `FEEDBACK_ONLY` keeps command telemetry off and permits only feedback-triggered Session Log sharing; every other supported state keeps this feed off.

The collection endpoint is a fixed constant (`DSH_TELEMETRY_ENDPOINT`).

## Model Experience

None, as the reporter sends developer-cycle telemetry from the launcher and never reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Placeholder endpoint** — `DSH_TELEMETRY_ENDPOINT` points at `.invalid` until the real endpoint is set.
- **Redaction is heuristic** — a conservative backstop, not a guarantee; secrets belong in `.env`, which is never read or reported.
