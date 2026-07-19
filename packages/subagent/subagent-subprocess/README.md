# @deepseek-ai/dsh-subagent-subprocess

Shared machinery for **out-of-process subagent backends** — providers that spawn an external agent as a child process, such as the [ACP backend](../subagent-acp/README.md). A pure library (no provider, no registration, no Config): what every spawn-a-CLI-child backend needs to keep the parent deployment's credentials out of the child, tear the child down to quiescence, and isolate it from the host user's on-disk CLI state. Design rationale: [the Claude Code / Codex subagent backends RFC](../../../docs/rfc/proposed/feature/2026-07-07-claude-code-and-codex-subagent-backends.md).

Every tunable is a **parameter**: the dispose ladder takes its grace periods per call, the config-dir helper takes an optional pinned path. Defaults live in each consuming plugin's Config (defaulted, validated fields changeable from `cordis.yml`), never in this library.

## What it exports

### `buildChildEnv(extra)`

The credential env scrub (same pattern as the [bash executor](../../bash/bash-local/README.md)): the child env is the ambient env minus credential-shaped vars (`/KEY|SECRET|TOKEN/i`), with `extra` layered on top AFTER the scrub. `PATH`, `HOME`, `TMPDIR`, locale, and proxy vars survive, so the child CLI runs normally; the parent's own secrets never leak implicitly, while an explicitly supplied credential (the child's OWN key in a backend's `env` config) still reaches the child.

### `spawnFailure(child)`

Spawn-failure capture: a promise that resolves (never rejects) with the child's first `error` event. A spawn failure such as `ENOENT` is an event, not a thrown exception — without a listener Node crashes the parent process — so call this in the same tick as `spawn()` and race it in the run's result path; a bad command then settles as an ordinary child-level failure. For a child that spawns cleanly the promise never settles.

### `disposeChildProcess(child, graces)`

The three-tier dispose ladder. Resolves only once the child has ACTUALLY exited — quiescence reached, not merely requested (see [defensive patterns](../../../docs/defensive-patterns.md)):

1. stdin EOF (when stdin is piped), then wait `graces.disposeEofGraceMs` — a cooperative child quiesces on its own, its flushes and nested-subprocess teardown intact;
2. `SIGTERM`, then wait `graces.disposeGraceMs`;
3. `SIGKILL`, then await the now-certain exit — a child that ignores EOF and traps `SIGTERM` cannot wedge dispose forever.

The two graces (`DisposeLadderGraces`) come from the consuming plugin's `disposeEofGraceMs`/`disposeGraceMs` Config fields; the EOF window is deliberately a separate — usually wider — grace than the signal tier, since a cooperative child's EOF teardown may itself await a signal-trapping grandchild plus a final flush.

The exit waits are internal to this ladder. They clean up their timer and listener on either outcome, so escalation never accumulates listeners on the child.

### `createIsolatedConfigDir(prefix, pinnedPath?)`

A per-run isolated config directory for an external CLI child (the target of `CLAUDE_CONFIG_DIR` / `CODEX_HOME`-style redirection), so child behavior is a function of deployment config alone — never of whatever `~/.claude` / `~/.codex`-style state exists on the host. Returns an `IsolatedConfigDir` handle: `path` goes into the child env, `remove()` runs on dispose.

- **Fresh (default)**: a private (0700) `mkdtemp` dir under the OS temp root; `remove()` deletes it best-effort (never rejects — a leftover temp dir beats a failed dispose) and is idempotent.
- **Pinned** (`pinnedPath` set): the path is returned as-is — never created, never removed. A deployment that pins a directory to share child state across runs owns that directory's lifecycle.

## Testing

`tests/subagent-subprocess.spec.ts`: the env scrub and config-dir helpers run against the real process env and real filesystem (the rm-failure path injects its rejection at the fs boundary — a real recursive-rm failure is not portably provokable, and root ignores permission bits); the exit waits and the dispose ladder run against a scriptable fake child, driving each escalation tier deterministically. The [ACP backend suite](../subagent-acp/README.md) exercises the same ladder against real subprocesses (EOF-cooperative, EOF-ignoring, and SIGTERM-trapping children) end to end.

## Model Experience

Indirectly, through process-based subagent backends, whose child composition is constrained by credential scrubbing and isolated config directories.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The credential scrub is name-based** — only variables matching `KEY` / `SECRET` / `TOKEN` are removed; differently named secrets such as `PASSWORD` pass through unless the backend supplies a stricter environment.
- **Signals target the direct child only** — teardown relies on a cooperative CLI to reap its descendants before exit; a re-parented or independently detached grandchild can outlive the ladder.
- **Fresh config-dir cleanup is best-effort** — an `rm` failure leaves private state under the OS temp root rather than failing disposal.
- **Pinned config directories are wholly operator-owned** — the helper neither creates, validates, locks, nor removes them, so concurrent runs may share and race on that state.
