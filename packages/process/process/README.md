# @deepseek-ai/dsh-process

The child-process manager seam (`ctx.processes`). The abstract `ProcessManager` exposes one method — `spawn(spec): ProcessHandle` — plus the vocabulary shared by every consumer: the fully-explicit `ProcessSpawnSpec`, `ProcessHandle` with its non-consuming offset-based output readers, `ProcessOutcome`, `CollectedOutput`, and the managed `DSH_*` environment namespace (`DSH_ENV_PREFIX`, `DshEnvironment`). The local implementation lives in [`dsh-process-local`](../process-local/README.md).

## Contract

- `spawn(spec)` returns immediately with a live handle; `done` resolves at process close and rejects only for spawn-level failures.
- The spec is fully explicit — argv, cwd, per-stream byte caps, spill cap, grace — because deployment-varying defaults belong to the calling seam's config, not to a hidden process-manager default (the `dsh-bash` request/spec split is the owning template). `argv` is never shell-interpreted here; a consumer that wants a shell passes `['bash', '-c', command]` itself.
- Output readers take whole-stream byte offsets and never consume: independent readers cannot steal one another's deltas. A read whose offset slid out of the in-memory tail is `lossy` and points at the full-stream spill file when one exists.
- `kill()` and the spec's abort signal escalate SIGTERM→grace→SIGKILL across the whole detached group; the manager reacts to the abort but never classifies why (callers own deadlines and cause classification).
- Disposal kills all still-running managed processes and awaits their exit.

See the [process data-structure catalog](../../../docs/core-data-structures/process.md) and the [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-26-process-manager-seam.md).

## Model Experience

Indirectly, through consumer seams (today the bash executor family behind `dsh-tool-bash`), which own all model-facing rendering of process output and lifecycle.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **One consumer family so far** — the seam's shape is proven against the bash executors only; the other in-repo spawn sites (LSP servers, PTY backends, subagent transports) keep their own bespoke process handling until their stream/lifecycle needs are re-examined against this contract.
- **POSIX group semantics are assumed** — the handle vocabulary (`pid` as group leader, group kills, SIGTERM/SIGKILL escalation) has no Windows story.
