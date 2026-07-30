# Agent Note: `dsh meta` boots the TUI over the harness checkout

Status: implemented

English | [中文](2026-07-28-dsh-meta-source-workspace.zh.md)

## Problem

`dsh` treats the invoking directory as the workspace, which is what makes it useful on arbitrary projects. Working on dsh itself therefore means `cd`-ing to the checkout first — and the checkout is not a memorable path: the source install keeps it under a container directory as a timestamped staging worktree (`~/.dsh/source/staging-<timestamp>`) behind a `current` symlink, so the target moves on every upgrade. The agent is already *told* where its source lives by the `harness:source` prompt section, and the `cordis` toolset can modify that runtime, but the human still had to locate the directory by hand to start a session there.

## Decision

`dsh meta` boots the ordinary TUI with the harness checkout as the workspace, from any directory.

The target is `SOURCE_ROOT` in `apps/cli/src/tui.ts` — `fileURLToPath(new URL('../../..', import.meta.url))`, three hops up from `apps/cli/{src,lib}` — the same constant the `harness:source` prompt section already names, so the workspace and the path advertised to the model cannot drift. It follows the launcher's real path, so a PATH symlink through `current` resolves to whichever staging worktree is active.

The mechanism is one `process.chdir(workspace)` inside `runTui`, guarded by a new optional third parameter that only `runMeta` passes. The cwd *is* the workspace seam in the shipped tree: `examples/tui-agent/cordis.yml` derives the session cwd (`!!js process.cwd()`), the `./.sessions` persistence root, and the HMR watch root (`root: ['.']`) from it, so one chdir moves all three together and meta sessions land in the checkout's gitignored `.sessions/`. It runs after both `.env` layers are loaded — the bin's invoking-directory load and the personal one — so the ambient > project > personal precedence is untouched. `DEFAULT_CONFIG` and `SOURCE_ROOT` are absolute and TUI mode passes no snapshot mode, so config resolution is chdir-independent.

`meta` accepts only `--resume <id>`. `--config` would boot a foreign tree against the harness workspace, which is the `--config` case rather than this one; `-p` is not interactive. Both fail loud, as does an empty `--resume=` — matching the default surface, where a swallowed empty id would silently start a fresh session.

**`meta` does not redeclare `--resume`.** Commander parses an option a subcommand shares with its parent into `program.opts()` and leaves the subcommand's own options object empty, so redeclaring it silently dropped the id (found by probing the adapter, not by review). The action reads `program.opts()`, which also accepts the flag on either side of the subcommand; `--help` still lists it among the parent's options.

## Testing

`apps/cli/tests/args.spec.ts` extends its two existing cases rather than adding a file: routing for `meta`, `meta --resume <id>`, and `--resume <id> meta` (pinning the shared-option behavior above), and exit-1 for `meta --resume=`, `meta --config`, and `meta -p`. `runMeta` itself is composition inside the module's existing `v8 ignore` block, like `runTui`.

There is no keyless PTY smoke for this mode. The smoke harness gives each run a temp cwd, but `dsh meta` deliberately chdirs to the real checkout, so a smoke would write `.sessions/` into the live tree mid-test. Covering it properly needs an injectable target directory — a test-only seam this note declines to add for a one-line chdir.

The mode was verified interactively instead. Launched from `$HOME`, a `pwd` tool call reports the checkout, git resolves to its branch, the session log lands under the checkout's `.sessions/` (leaving `~/.sessions` untouched and the tree free of unignored residue), and plain `dsh` from another directory still uses the invoking one.

`dsh meta --resume <valid-id>` once started a *fresh* session instead of resuming — a pre-existing defect on the default surface, not one this mode introduced. [Launcher-owned resume identity](../architecture/2026-07-28-launcher-owned-resume-identity.md) found the cause and fixed it: a personal overlay had replaced the whole `tui-agent` config block, overwriting the shipped `resumeSessionId` intake with a read of an unset environment variable, so a valid id was silently ignored. Session identity is now a launcher-owned context slot that no config key can displace, and `meta` routes through it.

## Alternatives considered

**Thread an explicit workspace through `boot` and the config tree.** Avoids mutating process-wide state, but the shipped config reads the cwd in three places (`!!js process.cwd()`, `persistenceRoot`, HMR `root`), so each would need its own new plumbing and config key to stay consistent. `chdir` before boot expresses "this is the workspace" once, at the seam that already means it.

**A `--meta` flag on the default surface.** Rejected: the default surface is option-only so that subcommands do not collide with a positional, and a flag that silently relocates the workspace reads as a modifier of the current directory rather than a different target. `meta` alongside `web` matches the existing shape.

**Resolve `~/.dsh/source/current` instead of the launcher's own path.** Rejected: it would diverge from the `harness:source` prompt path whenever a non-installed checkout's `bin/dsh` is invoked directly, telling the model one source root while working in another.

**Make the printed resume hint mode-aware.** Deferred here as a known cost, then delivered by [launcher-owned resume identity](../architecture/2026-07-28-launcher-owned-resume-identity.md): the exit line became a launcher-provided context slot, so meta mode prints `dsh meta --resume <id>` and a copied hint works from any directory. It previously came from static config as `dsh --resume {session}` and only worked when re-run from the checkout.

## Consequences

Starting a session on dsh's own source is `dsh meta` from anywhere, and the workspace is guaranteed to be the same checkout the model is told about. Meta sessions are isolated in the checkout's `.sessions/`, so `dsh meta --resume` sees only other meta sessions — intended, since a session's logged cwd belongs to its workspace.

The resume hint was this mode's original cost and is now resolved. [Launcher-owned resume identity](../architecture/2026-07-28-launcher-owned-resume-identity.md) made both the printed line and the in-place `/resume` handoff reproduce the mode as `dsh meta --resume <id>` from one shared argv helper, so a copied hint works from any directory and the handoff no longer depends implicitly on `execve` preserving the process cwd.

`runTui` gains an optional third parameter, so the workspace override is visible at the one function that owns TUI composition rather than hidden in a second copy of it.
