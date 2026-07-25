# @deepseek-ai/dsh-process-local

Local-subprocess implementation of the [`@deepseek-ai/dsh-process`](../process/README.md) manager seam: `LocalProcessManager` spawns each spec's argv as a detached process group, collects bounded output with size-limited full-stream spill files, and escalates kills SIGTERM→SIGKILL across the whole group. It has no config: every limit and directory arrives on the spawn spec, so the deployment-varying knobs stay with the calling seam's config ([`dsh-bash-local`](../../bash/bash-local/README.md) today).

## Behavior (and where it came from)

- **Detached process groups with escalation** — children are spawned `detached` (own process group); kills send SIGTERM to the group, then SIGKILL after the spec's grace (OpenCode's escalation; pipelines and subshells die with the parent). After the leader exits, inherited stdout/stderr pipes receive the same bounded drain grace so a surviving descendant cannot hold the spawn open indefinitely. ESRCH is tolerated; daemons that re-parent away from the group can still survive — the same caveat as the surveyed tools.
- **Tail-keep truncation + bounded spill files** — output beyond a stream's cap keeps the in-memory TAIL (errors and results cluster at the end — pi/OpenCode rationale) while the FULL stream is appended to a private temp file whose path is reported when available. A stream larger than the spill cap discards its now-incomplete spill and returns only the marked truncated tail; a failed final close withholds the path rather than advertising an incomplete file. Spill files are `0600` with random names under a lazily-created `0700` per-process directory.
- **Credential scrub + managed `DSH_*` merge** — `process.env` minus credential-shaped vars (`*KEY*`/`*SECRET*`/`*TOKEN*`) and all ambient `DSH_*` names; a spec's ordinary `env` merges after the scrub but rejects `DSH_*`; managed `dshEnv` rejects ordinary names and merges last, preventing stale nested-harness identity. Supplied stdin is written and closed; otherwise fd 0 is `/dev/null`. See the [stdin/env Agent Note](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md) and [managed environment Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.md).
- **Offset-based reads** — `ProcessHandle` readers return deltas in whole-stream byte coordinates; the manager never holds a cursor, so consumer-owned cursors (the bash background read path) and full-stream re-reads coexist.
- **Kill-and-join disposal** — the manager retains live handles only so its own disposal can kill every running group and await its exit; settled and spawn-failed handles leave the live set on settlement.

## Model Experience

Indirectly, through consumer seams (today the bash executor family behind `dsh-tool-bash`), which own all model-facing rendering of process output and lifecycle.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **POSIX-only** — detached process groups, group kills, and SIGTERM→SIGKILL escalation are hardcoded; Windows is unsupported.
- **The credential scrub is a name heuristic** — `*KEY*`/`*SECRET*`/`*TOKEN*` only; differently-named secrets (e.g. `*PASSWORD*`) pass through, and a whitelist for over-scrubbed vars is noted future work.
- **Completed spill files are not deleted** — bounded full-output recovery files (and the private per-process spill dir) accumulate under the OS tmpdir until something external cleans them; oversize incomplete spills are discarded and deletion is attempted immediately, but a cleanup failure can leave a bounded file behind.

The raw process handling lives in `src/spawn.ts`; `src/index.ts` is the service wiring.
