# Agent Note: request-level LLM configuration and the credential seam

Status: implemented

English | [中文](2026-07-29-request-level-llm-config-credentials.zh.md)

> Scope: the first production consumers of `ctx.settings` (the two LLM adapter plugins) and the `packages/credentials/` capability family. The later [read-only credentials and static routes](../simplification/2026-07-31-read-only-credentials-and-static-llm-routes.md) decision removes speculative credential mutation, the atomic-write extraction, and settings-driven route lifecycle; this note owns the surviving request-resolution rationale.

## Problem

The [settings seam](2026-07-28-user-settings-seam.md) shipped without a production consumer, and the LLM adapters were the motivating one: both froze `apiKey`/`baseURL`/catalog into adapter instances at plugin load, so a changed key or endpoint needed a process restart, and a missing key failed plugin load — the worst possible first-run posture for a personal config page ("store a key, then restart"). Secrets were also headed the wrong way: the natural move (put `apiKey` in the settings document) would have forced masking, server-side backfill on `replace`, and dotfiles-sync warnings, a mitigation stack for a problem peer products simply do not have — Codex (`env_key` + auth.json), Reasonix (`api_key_env` + home `.env`), OpenCode/Pi (`auth.json`), Claude Code (`apiKeyHelper`) all keep secrets out of configuration files.

## Decision

**Per-request resolution, not fiber rebuilds.** The adapters take an options thunk and a per-stream credential resolver instead of rebuilding their fibers. Connection, credential, and request-transport facts are read for the operation, while an in-flight stream keeps the facts it started with. A missing key is a request-time `MISSING_CREDENTIAL` failure while the route remains registered. Provider routes and their retry policies are composition-fixed instead of triggering registration swaps.

**Secrets are references, values live behind `ctx.credentials`.** Configuration can carry `apiKeyEnv: DEEPSEEK_API_KEY`; the read-only credential seam resolves it per operation. `credentials-local` checks the live process environment first, then parses `$DSH_HOME/.env` on demand, with no cache or mutation surface. Resolution order in the adapters is a non-empty literal `apiKey` first, then the seam, then — only without a mounted seam — the named raw environment variable.

**Per-plugin namespaces, schema ≡ `Config`.** Each adapter registers its own namespace (`llm-deepseek`, `llm-pi-ai`) with its plugin `Config` schema and `cordis.yml` entry as the composition `base`. `resolveAdapterOptions` and `resolveProfiles` remain the explicit validation steps, and a bad live snapshot keeps the last good request facts while a bad entry config fails load. pi-ai's `providers` is a non-empty dict keyed by its composition-owned routes; the user layer may override request facts for those routes but cannot add or remove them.

## Alternatives considered

- **A bridge plugin (`dsh-llm-models`) owning one unified `models` dict** — with per-plugin namespaces there is nothing left to bridge, and the adapter-mapping rules it needed were pure invented indirection.
- **Secrets in settings.yaml under `role('secret')` masking** — deleting the problem (references) beats mitigating it (mask + backfill + sync warnings); the coding-agent cohort is unanimous.
- **Registry-level live retry policy** — making `providerRetryPolicy` re-read per call would silently change the `ctx.llm` capture contract every registration relies on; retry policy therefore stays fixed with the composition-owned route.

## Consequences

Booting without a key remains valid: the first request fails with the named reference, and an externally supplied environment or dotenv value reaches the next request without restart. The demos mount `settings-local` and the read-only `credentials-local` provider by default and inline no `!!js` key plumbing. The credential-management RPC/UI and registration mutation are absent until a current consumer justifies their contracts. Settings-layer arrays still replace wholesale, and pi-ai provider routes remain composition decisions. The [credential-boundaries note](2026-07-30-credential-boundaries-and-atomic-registration.md) owns the surviving storage and request-generation safety decisions.
