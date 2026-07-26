# @deepseek-ai/dsh-subagent-subprocess

English | [中文](README.zh.md)

Shared machinery for **out-of-process subagent backends** — providers that spawn an external agent as a child process, such as the [ACP backend](../subagent-acp/README.md) and the [SDK backend](../subagent-sdk/README.md). A pure library (no provider, no registration, no Config): what every spawn-a-CLI-child backend needs to keep the parent deployment's credentials out of the child, tear the child down to quiescence, resolve the child's working directory, publish the seam run handle, and isolate the child from the host user's on-disk CLI state. Design rationale: [the Claude Code / Codex subagent backends Agent Note](../../../.agents/notes/proposed/feature/2026-07-07-claude-code-and-codex-subagent-backends.md).

Every tunable is a **parameter**: the dispose ladder takes its grace periods per call, the config-dir helper takes an optional pinned path. Defaults live in each consuming plugin's Config (defaulted, validated fields changeable from `cordis.yml`), never in this library.

## What it exports

### `buildChildEnv(extra)`

The credential env scrub (same pattern as the [bash executor](../../bash/bash-local/README.md)): the child env is the ambient env minus credential-shaped vars (`/KEY|SECRET|TOKEN/i`), with `extra` layered on top AFTER the scrub. `PATH`, `HOME`, `TMPDIR`, locale, and proxy vars survive, so the child CLI runs normally; the parent's own secrets never leak implicitly, while an explicitly supplied credential (the child's OWN key in a backend's `env` config) still reaches the child.

### `spawnFailure(child)`

Spawn-failure capture: a promise that resolves (never rejects) with the child's first `error` event. A spawn failure such as `ENOENT` is an event, not a thrown exception — without a listener Node crashes the parent process — so call this in the same tick as `spawn()` and race it in the run's result path; a bad command then settles as an ordinary child-level failure. For a child that spawns cleanly the promise never settles.

### `disposeChildProcess(child, graces)`

The platform-aware dispose ladder resolves only once the child has ACTUALLY exited — quiescence reached, not merely requested (see [defensive patterns](../../../docs/defensive-patterns.md)):

1. stdin EOF (when stdin is piped), then wait `graces.disposeEofGraceMs` — a cooperative child quiesces on its own, its flushes and nested-subprocess teardown intact;
2. on POSIX, `SIGTERM`, then wait `graces.disposeGraceMs`;
3. force termination — `SIGKILL` on POSIX and Node's `TerminateProcess` mapping on Windows — then wait at most `graces.disposeGraceMs` for exit; a signal error or missing exit rejects disposal.

The two graces (`DisposeLadderGraces`) come from the consuming plugin's `disposeEofGraceMs`/`disposeGraceMs` Config fields. POSIX uses `disposeGraceMs` after both the graceful and forced signals; Windows skips the redundant graceful signal but uses it to bound forced-exit confirmation. The EOF window is deliberately separate and usually wider, since cooperative teardown may await a signal-trapping grandchild plus a final flush.

The exit waits are internal to this ladder. They clean up their timer and listener on either outcome, so escalation never accumulates listeners on the child.

### `assertUsableCwd` / `validateConfiguredCwd` / `resolveChildCwd`

Child working-directory resolution, shared verbatim by the ACP and SDK backends: a configured `cwd` override is validated ONCE at load (`validateConfiguredCwd` — rejects the empty string, resolves a relative path against the harness launch directory, requires an enterable directory), and `resolveChildCwd` applies it per start, else validates the delegating parent session's cwd — never the server process's own cwd, because one server process serves many sessions. `assertUsableCwd` is the underlying probe: absolute, existing, and searchable (`X_OK` — what a subprocess cwd actually needs; a mode-600 directory passes `isDirectory()` but fails spawn with EACCES). Every diagnostic is prefixed with the consuming plugin's name.

### `NO_START_CAPABILITIES` / `settleRunResult` / `subprocessRunHandle`

The provider-side skeleton every out-of-process backend shares. `NO_START_CAPABILITIES` is the frozen all-false advertisement (an out-of-process child cannot honor parent-enforced start features, so the service rejects such requests before `start`). `settleRunResult` settles the run result under the seam's never-reject contract: an attempt rejection reads as `aborted` when local cancellation already settled, else flattens to `stopReason: 'error'` through a throw-contained diagnostic sink, always removing the abort listener. `subprocessRunHandle` publishes the seam handle with idempotent dispose: remove the listener, settle local cancellation, then await the backend's teardown to actual exit.

### `createIsolatedConfigDir(prefix, pinnedPath?)`

A per-run isolated config directory for an external CLI child (the target of `CLAUDE_CONFIG_DIR` / `CODEX_HOME`-style redirection), so child behavior is a function of deployment config alone — never of whatever `~/.claude` / `~/.codex`-style state exists on the host. Returns an `IsolatedConfigDir` handle: `path` goes into the child env, `remove()` runs on dispose.

- **Fresh (default)**: a private (0700) `mkdtemp` dir under the OS temp root; `remove()` deletes it best-effort (never rejects — a leftover temp dir beats a failed dispose) and is idempotent.
- **Pinned** (`pinnedPath` set): the path is returned as-is — never created, never removed. A deployment that pins a directory to share child state across runs owns that directory's lifecycle.

## Testing

`tests/subagent-subprocess.spec.ts`: the env scrub and config-dir helpers run against the real process env and real filesystem (the rm-failure path injects its rejection at the fs boundary — a real recursive-rm failure is not portably provokable, and root ignores permission bits); the exit waits and platform termination paths run against a scriptable fake child. The [ACP backend suite](../subagent-acp/README.md) exercises them against real subprocesses end to end.

## Model Experience

Indirectly, through process-based subagent backends, whose child composition is constrained by credential scrubbing and isolated config directories.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The credential scrub is name-based** — only variables matching `KEY` / `SECRET` / `TOKEN` are removed; differently named secrets such as `PASSWORD` pass through unless the backend supplies a stricter environment.
- **Signals target the direct child only** — teardown relies on a cooperative CLI to reap its descendants before exit; a re-parented or independently detached grandchild can outlive the ladder.
- **Fresh config-dir cleanup is best-effort** — an `rm` failure leaves private state under the OS temp root rather than failing disposal.
- **Pinned config directories are wholly operator-owned** — the helper neither creates, validates, locks, nor removes them, so concurrent runs may share and race on that state.
