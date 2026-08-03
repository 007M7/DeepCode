# Agent Note: Default session-telemetry mount (OTel reporting) in the dsh web composition

Status: implemented

English | [中文](2026-07-31-web-telemetry-default-mount.zh.md)

## Problem

The telemetry seam and OTel backend ([revival Note](2026-07-23-session-telemetry-otel-revival.md)) had never been wired into any deployment composition since completion: no roster row, no switch, no cadence ruling, and zero observability over user sessions for the internal deployment. A deployment decision was needed: which surfaces report, to where, on what cadence, how to opt out, and how CI stays isolated.

## Decision

The shared `dsh` core (`apps/cli/config/base.cordis.yml`) mounts the `telemetry-otel` row by default with a baked-in production endpoint, so every surface — TUI, web, and headless — reports; this is the **internal-testing deployment stance** — reporting is on when an endpoint exists, and users opt out through the environment. Each surface's exit path drains the queue: web/headless dispose on SIGINT/SIGTERM (headless gained those handlers in this change), and the TUI's normal exit runs `disposeRootAndExit` (root dispose, 5s bounded — above the ~1s drain ceiling configured here) while its `/resume` handoff disposes the root before `execve`.

| Ruling | Value | Rationale |
|---|---|---|
| Mount surface | base.cordis.yml (TUI + web + headless) | One deployment stance for every surface; per-surface divergence would need a reason, and none exists |
| Endpoint | `DSH_TELEMETRY_OTLP_URL`, default `https://harness-telemetry.deepseeksvc.com/v1/logs` | Internal collector; the env override serves local/dev runs |
| Opt-out switch | any non-empty `DSH_TELEMETRY_DISABLED` (including `0`/`false`) disables | A privacy switch prefers off-by-mistake over on-by-mistake; a row can only be disabled at AppCLIEntry's patch layer (config has no disable semantic, and the switch must precede the load-time `exporter.url` validation) |
| Cadence | `processor.scheduledDelayMillis: 10000` (10s/batch) | Streaming while the session runs, never exit-time-only; a crash loses at most the last unexported interval |
| Exit-drain bound | `exporter.timeoutMillis: 1000` + `maxExportBatchSize: 2048` (== maxQueueSize) + `exportTimeoutMillis: 1500` | Dispose must release within ~1s against an unreachable collector: timeoutMillis doubles as the per-attempt socket timeout and the retry deadline (1s effectively disables the SDK's 5-try backoff), and aligning batch size with the queue cap makes the drain a single batch; SDK defaults can stall 40s+ |
| Compression | `compression: gzip` | Event bodies carry full content; cross-datacenter bandwidth |
| CI isolation | top-level `env: DSH_TELEMETRY_DISABLED: '1'` in all 8 GitHub workflows | Every CI channel that boots the web composition (e2e/snapshot/built smokes) must not stream test sessions to the production endpoint |

The keyless integration test `apps/cli/tests/telemetry-web.e2e.ts` pins the deployment-level behavior: an in-test OTLP collector plus a mock LLM server, a real `dsh web` boot, asserting ledger coverage, seq monotonicity, the first-of-step chunk projection, and the ops `shutdown` marker arriving through the SIGINT drain.

## Alternatives considered

**No default mount; deployments add the row themselves (continuing the SDK stance).** Rejected for this stage: this repo's web/headless composition IS the internal deployment, and default-on reporting is that deployment's product requirement; the SDK stance survives in the seam packages (unmounted = nothing leaves).

**A config field instead of an env patch for the switch.** Infeasible: cordis rows have no config-level disable semantic, and `exporter.url` validation fails loud at plugin construction, so the switch must take effect before the Loader — AppCLIEntry's patch layer is the only seat.

**A `Promise.race` timeout backstop around exit.** Deferred: the parameter set already bounds the worst-case drain to ~1.5-3s (typically <100ms), measured SIGINT-to-exit 110ms-1.1s; the unbounded drip-feed-response risk stays under observation, and on real evidence the race lands inside the backend's `shutdown()` (never the coordinator — that would decide loss semantics for every backend).

## Consequences

- A developer running `dsh web` without a local collector POSTs to the production endpoint every 10s (silent failure when unreachable; no OTel diag logger is registered); local development sets `DSH_TELEMETRY_DISABLED=1` or points `DSH_TELEMETRY_OTLP_URL` locally.
- **No redaction rule is mounted yet**: exports are the raw captured copy (full user/assistant message text, tool arguments and results, the system prompt, the local `session.cwd` path). Crossing a trust boundary requires `telemetry/record` rules first — the redaction rule, the remaining identity Resource attributes (hostname / surface; the anonymous user id shipped via the [anonymous-user-id Note](2026-07-31-telemetry-anonymous-user-id.md)), and the usage-metrics track are the explicit follow-ups of this decision.
- Test rigs reusing this tree (e.g. `apps/web/tests/scaffold.ts`) must explicitly disable the row, or fixture sessions stream to whatever collector the environment happens to name.
