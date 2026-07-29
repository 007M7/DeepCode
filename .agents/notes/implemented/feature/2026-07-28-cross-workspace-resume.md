# Agent Note: Cross-workspace session resume

Status: implemented

English | [中文](2026-07-28-cross-workspace-resume.zh.md)

## Problem

`/resume` could only reach sessions started in the launch directory, so returning to yesterday's work in another project meant remembering its path, leaving the TUI, and relaunching there. Two independent causes produced that limit, and fixing either alone changes nothing.

Storage was the binding one. The shipped `tui-demo` bundle defaulted `persistenceRoot` to a relative `./.sessions`, so each launch directory owned a disjoint JSONL root and a disjoint derived `session-query.db`. Sessions from another project were not filtered out of the listing — they were absent from the store the listing reads. The JSONL backend already partitions per-cwd *inside* one root, so the partitioning was doubled: once by root, once within it.

The picker then filtered again. It dropped records whose `cwd` differed from the current session before display, and `summarizeResumeCandidate` independently marked a differing `cwd` as `disabledReason: 'different workspace'`, so a foreign session that did reach the store was both hidden and refused.

Finally, resume never changed directory. The host re-execs `dsh --resume=<id>` through `process.execve`, which inherits the cwd. Session *header* cwd is restored from the log, but process cwd is what `dsh-fs-local`, the bash executor, and glob/grep resolve against, so resuming a foreign session would have replayed its transcript while acting on the wrong project.

## Decision

The dsh launcher supplies one session root under its Harness home through a boot slot, the picker gains a workspace scope, and the handoff carries the target directory.

**Storage.** `dsh-paths` owns the location as `resolveSessionsRoot()` (`sessions` under the Harness home, by `resolveDshHome`'s precedence), but only the launcher assumes it: shared-store policy is the dsh CLI's, never a plugin's. The TUI surface provides the root through the `SESSIONS_ROOT_KEY` boot slot (`ctx.provide` before Loader entries mount) and `dsh web` patches the same root in `apps/cli/src/app-cli-entry.ts`. Two CLI surfaces computing that path independently is exactly the failure this change fixes — disjoint stores — so the fact gets one home rather than a `join` per caller, alongside the existing `registryRoot()` precedent for `run`.

`tui-demo` itself keeps a project-local `./.sessions` default and reads the launcher slot between explicit config and that default (`config.persistenceRoot ?? ctx.get(SESSIONS_ROOT_KEY) ?? './.sessions'`). The precedence lives in `composeTuiApp`, not as a schemastery `.default()`, because a schema default would materialize before the compose function runs and shadow the slot for every Loader mount. `examples/tui-agent/cordis.yml` omits `persistenceRoot` so the launcher slot (or, for a bare example boot, the project-local default) applies. Configuring an explicit root always wins, which remains the correct choice for a hermetic deployment.

**Scope, not exclusion.** A workspace other than the current one is a display scope rather than a disabled reason. `showResume()` summarizes every record and the `ResumePicker` owns a `scope` of `'workspace' | 'all'`, defaulting to the current workspace so the common case is unchanged. Tab toggles; the scope line names the active scope and the count the other holds; each row in the all-workspaces scope reports its own workspace, and that label joins the searchable text only in the scope that shows it. A toggle clears the query and selection so the highlighted row always belongs to the visible list, and the per-row workspace line makes a row one terminal row taller in that scope, which the visible-count budget accounts for.

`summarizeResumeCandidate` therefore drops `'different workspace'` and gains `'session has no recorded workspace'`. That is a real new refusal rather than a rename: a header without `cwd` names no directory for the host to enter, so it cannot be handed off even though its log is intact.

**Handoff.** `TuiResumeHost.handoff` takes the target `cwd` beside the `SessionId`. `preflightResume` resolves both together and returns them, so the caller cannot re-derive a stale directory from the row it displayed — a record whose `cwd` moved between listing and preflight is resumed in the *re-read* directory, which is why the former "reject a moved cwd" behavior is now a handoff with the new path. The shipped host chdirs before disposing the app: an unreachable directory must reject while the caller can still restore the terminal, because after teardown no owner remains to report to. `resumeArgs` keeps the `meta` subcommand form only when the target is this checkout, since `dsh meta` chdirs to the harness source itself and would override any other workspace.

## Alternatives considered

**Patch `persistenceRoot` from the `dsh` launcher instead of changing the bundle default.** Rejected after finding that a loader patch assigns `config` wholesale. The personal `~/.dsh/config.yaml` overlay already patches the `tui-agent` row with a partial config, which is exactly why `persistenceRoot` was falling back to the bundle default in the first place; a launcher patch would either be erased by that overlay or have to win over it and make the overlay unable to set the field. Owning the default in the bundle survives any partial patch and keeps one home for the fact.

**Keep `./.sessions` and additionally scan the Harness-home root.** Rejected: two roots means two SQLite indexes and a merged listing whose rows have different liveness and revision authorities, to preserve visibility of logs that the no-migration decision already gives up.

**Migrate existing project-local logs into the shared root.** Rejected by the requester. Sessions under a project's `./.sessions` stay on disk and stay resumable by explicit `dsh --resume <id>` from that directory, but no longer appear in `/resume`.

**One flat list of every workspace.** Rejected: it loses the "this project" default that the overwhelmingly common case wants, and in a busy home directory the current project's sessions would compete with unrelated ones.

**Let the host infer the directory from the restored session header.** Rejected: the header is model- and prompt-facing state restored *after* boot, while the directory must be entered *before* `execve`. Passing it explicitly keeps the ordering visible at the seam.

## Consequences

- Sessions already stored under a project-local `./.sessions` disappear from `/resume`. This is the accepted cost of no migration.
- One shared root makes the pre-existing absence of a cross-process session lock reachable in one step: colliding used to require two terminals in the same directory, and is now one Tab away. `record.live` comes from the in-process `SessionQueryService`, so preflight rejects only sessions live in *this* runtime, while the JSONL backend takes no lock and two processes appending one log with independent `seq` counters would interleave. Closing this is no longer speculative hardening: `SessionRegistry.list()` already publishes live sessions cross-process under the same Harness home for `dsh list-sessions`, so consulting it in `summarizeResumeCandidate` is a small follow-up. It stays out of this change as pre-existing scope.
- A resumed session can change the process's working directory, so a foreign resume is not a pure transcript restoration — every path-resolving tool moves with it.
- The Harness home now holds session logs for every project on the machine. Its growth is no longer bounded by one checkout, and no retention policy is introduced here.

## Testing

TUI tests cover the default scope hiding other workspaces while reporting their count, Tab revealing them with per-row workspace labels, Tab back clearing the query and selection, searching by workspace label, a cwd-less record staying visible but disabled, and the handoff receiving both the id and the workspace re-read at preflight. The former "reject a moved cwd" case now asserts the handoff carries the new directory. `dsh-paths` tests pin `resolveSessionsRoot`'s precedence against `resolveDshHome`'s. `tui-demo` composition tests pin the project-local default and the derived `session-query.db` path. The keyless TUI snapshot pins both scopes of the selector, including the scope line, the per-row workspace lines, and the Tab hint in the footer. A manual cross-workspace resume verified at the process level that the replacement's working directory became the target workspace.
