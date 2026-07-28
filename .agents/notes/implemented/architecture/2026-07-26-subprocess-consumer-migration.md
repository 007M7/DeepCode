# Agent Note: The subprocess seam goes Node-shaped and every eligible spawner rides it

Status: implemented

English | [中文](2026-07-26-subprocess-consumer-migration.zh.md)

## Problem

The [subprocess seam](2026-07-26-subprocess-seam.md) shipped shaped for exactly one consumer family: batch-collected stdout/stderr, batch stdin, a single escalating `kill()`. That was deliberate scope control, and its own note records "migrate the other spawn sites" as rejected-for-now. Review on the introducing PR reversed that deferral: the stacked follow-up should reshape the interface toward Node's API and move the remaining process-running places onto the service. The remaining spawners each carried a private copy of some slice of the same mechanics — lsp-local had its own detached-tree signalling (POSIX group + Windows taskkill + liveness polling), subagent-subprocess had the dispose ladder and its own scrub, mcp-client and pty-local and the SDK helper each had a third/fourth/fifth copy of the credential scrub — and none of it was swappable or centrally testable.

## Decision

The seam's vocabulary is now Node-shaped, and every spawner that can ride the service does:

- **Per-stream stdio dispositions** on `SubprocessSpawnSpec`: `'pipe'` (the raw `Readable`/`Writable`, for consumer-owned protocol framing), `'inherit'` (diagnostics to the parent's stream), and collect mode `{ maxBytes, spill? }` — the original bounded tail-keep shape, with the spill file now optional so a diagnostic tail (a language server's stderr) buffers without touching disk. stdin is `'ignore'`, `'pipe'`, or `{ data }` (write-and-close batch).
- **`SubprocessOutcome` carries exit facts only** (Node's close-event vocabulary); collected output stays readable through `handle.collected` after settlement (spill fds seal at the settle boundary), so batch and streaming callers share one access path and nothing is copied into the outcome.
- **Tree-scoped termination behind one verb**: `terminate()` owns the SIGTERM→grace→SIGKILL escalation (serves the spec's abort signal too, and is a no-op once the tree is gone) — the handle exposes no single-signal `kill(signal?)`, so a consumer cannot skip the grace window; `waitForExit()` polls tree liveness (POSIX group probe; direct-child boundary on Windows); Windows tree termination (`taskkill /T`, injectable) moved in from lsp-local, so tree semantics are platform-correct for every consumer. (The stdin-EOF-first dispose ladder initially absorbed from `subagent-subprocess` later moved back out to its one consumer — see the [ladder-ownership Agent Note](2026-07-27-dispose-ladder-to-consumer.md).)
- **One scrub definition**: `scrubbedParentEnv()`/`SENSITIVE_ENV_PATTERN` live on the seam. Ordinary and terminal local spawns apply it inside `dsh-subprocess-local`; mcp-client still imports it because the MCP SDK owns that transport spawn, and the SDK helper's `scrubEnvironment()` defaults through it as well.

Migrations landed with the reshape: **bash-local/bash-sandbox** (collect modes + batch stdin; the bash `kill()` maps to `terminate()` so `task_kill` keeps escalation semantics), **lsp-local** (piped protocol streams + a no-spill collected stderr tail; `LspConnection` takes the seam's spawn function; its private tree-op helpers deleted), **subagent-acp** (piped ndjson streams + inherited stderr; spawn failure surfaces through `done` rejection into the same startup race; disposal is the backend-owned `disposeAcpChild` ladder over the seam's verbs, with the plugin's configured graces), and **pty-local** through the later [portable execution-world decision](2026-07-28-portable-execution-world-consumers.md) (`node-pty` allocation and process inspection sit behind `spawnTerminal()`, while readiness and terminal policy remain in the consumer). **`dsh-subagent-subprocess` is deleted** — the dispose ladder and scrub are the seam's; the unused isolated-config-dir helper died with it (no consumer existed).

Compositions mounting lsp-local or subagent-acp now load `dsh-subprocess-local` (the plugins inject `'subprocess'`); the acp/lsp test fixtures gained the row.

## Alternatives considered

**Keep the batch-only seam and let stream consumers stay bespoke.** The introducing note's position, rejected by review: it leaves three private copies of tree signalling and five of the scrub, and any future runner (containerized executor, remote process host) would have to pick which private copy to fork. The Node-shaped dispositions cover all three observed stream shapes without widening the outcome type or buffering piped streams.

**A single `stdio: 'pipe' | 'inherit' | 'collect'` mode for all three streams at once.** Rejected: real consumers mix modes per stream (lsp: pipe/pipe/collect; acp: pipe/pipe/inherit; bash: data/collect/collect). Per-stream dispositions are exactly Node's shape and avoid a second spawn call for the mixed cases.

**Keep pty-local and mcp-client spawns outside the service.** The MCP SDK still owns its transport spawn. PTY allocation is different: the [portable execution-world decision](2026-07-28-portable-execution-world-consumers.md) moves `node-pty` behind one deep terminal primitive, resolving the ownership objection without pretending an ordinary piped spawn can provide terminal semantics.

**Migrate the test-support launchers (acp-snapshot, loader-smoke) and the SDK package-manager runner.** Rejected: the support packages are deliberately dependency-light test infrastructure that must not depend on product seams, and the SDK wizard's `stdio: 'inherit'`-with-redirect semantics plus its out-of-composition lifecycle (no cordis context at all) make the service a poor fit; it shares the scrub instead.

## Consequences

Bought: one implementation of tree signalling, escalation, bounded collection, terminal process mechanics, and the scrub, tested once in `dsh-subprocess-local`'s suites (including injected-platform Windows coverage that lsp-local's private copy never had); lsp-local, pty-local, and subagent-acp shed provider-specific process plumbing and their children die with composition teardown like bash's; a whole package (`dsh-subagent-subprocess`) is gone. The seam README's "one consumer family" limitation is retired.

Cost: the seam is wider — execution-world coordinates, executable lookup, three stdio modes, process-tree lifecycle, and one terminal primitive — so a future backend implements more surface; the compositions for lsp-local, pty-local, and subagent-acp each carry the subprocess row; and `SubprocessOutcome` no longer carries output, a breaking shape change inside the still-unreleased stack. MCP/SDK/test-support spawns remain outside the service by ownership, with the scrub as the shared floor.
