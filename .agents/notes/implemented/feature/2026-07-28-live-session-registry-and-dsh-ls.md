# Agent Note: live-session registry and `dsh list-sessions`

Status: implemented

English | [中文](2026-07-28-live-session-registry-and-dsh-ls.zh.md)

## Problem

Nothing could answer "which dsh sessions am I running right now". A user with sessions across several projects had no way to enumerate them, and no way to recover the id needed for `--resume` except the exit line of the terminal that printed it. Session persistence records every session that ever existed, so it cannot answer the question: it has no notion of liveness, and no `process.pid` appeared anywhere in the session, persistence, or storage packages.

## Decision

`dsh list-sessions` (alias `dsh ps`) lists the sessions running right now — session id, pid, uptime, workspace, title — newest first, across every workspace, with `--json` for machines. Three packages back it, as a capability seam.

[`dsh-session-registry`](../../../../packages/session-registry/session-registry/README.md) (`ctx.sessionRegistry`) is the seam: the abstract service contract and record vocabulary, so the medium can later move to a database without touching consumers. [`dsh-session-registry-file`](../../../../packages/session-registry/session-registry-file/README.md) implements it over one lock-guarded JSON file under the Harness home. [`dsh-session-registry-live`](../../../../packages/session-registry/session-registry-live/README.md) follows `session/created`, `session/disposed`, and `session/title` and keeps the registry in step. `apps/cli` mounts both on every launcher surface — the TUI, `dsh meta`, headless, and web — and `dsh list-sessions` mounts only the service, booting no agent tree. No surface label is recorded: a launcher's mode is not a property of the session, and the workspace column already distinguishes a `dsh meta` session from a project one.

### Liveness is derived, never stored

`list()` probes each record's pid with `kill(pid, 0)` and drops the dead ones, writing the pruned result back. A process killed without running its disposer leaves a record that the next read removes, so there is no daemon, no heartbeat, and no permanent phantom. A per-process `bootId` distinguishes a recycled pid, so deregistration cannot delete a namesake record from a different incarnation. `EPERM` counts as alive: a live session owned by another user must not be dropped.

### Two independent concurrency layers

The file is written by every dsh process and by several sessions inside one process, and the two cases need different mechanisms.

Across processes, each read-modify-write holds a [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) advisory lock. Within one process, calls queue on an internal chain, because the advisory lock is tracked per process: overlapping same-process callers contend for its bounded retry budget rather than queueing, and past roughly a dozen concurrent calls that budget runs out and a registration rejects. Since publication is fire-and-forget, such a rejection silently drops a live session from the listing — the exact "listing that lies" failure this feature exists to avoid. Both layers are load-bearing and each is pinned by a test that fails without it.

### Records carry their own title

The title is the one mutable field, replaced through `retitle` as `session/title` events arrive. It lives in the record rather than being read from the session log because the log's location, format, and compression are per-deployment backend choices: the TUI writes project-local zstd-compressed JSONL, the web and headless surfaces write to a global root, a user profile overrides either, and SQLite has no per-session file at all. An independent reader cannot portably parse that, so `dsh list-sessions` opens no log and assumes no backend.

### Subagents are invisible by construction

Only top-level launcher surfaces mount the publisher. In-process subagents (`spawn`, `fork`) have no process of their own, and the out-of-process backends spawn `dsh-jsonrpc-agent` rather than this CLI. No filter flag is needed, and no subagent package changed.

## Alternatives considered

**One file per session under `~/.dsh/run/`.** No lock at all, since each process only writes and deletes its own file. Rejected in favour of the single file the user chose, which then made a real advisory lock mandatory rather than optional.

**A domain over the `storage-json` backend.** The obvious reuse, and wrong: that backend documents "no cross-process write locking … last write wins" and names single-host-process as its assumption, and the [domain KV storage note](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) puts multi-process explicitly out of scope. A registry written concurrently by every launcher is precisely that excluded case. Widening the backend's contract would have changed a shipped guarantee for one consumer; a separate package owns the multi-process medium instead.

**Hand-rolled `O_EXCL` lock directory.** Rejected under the [dependencies-over-hand-rolling policy](../process/2026-07-26-dependencies-over-hand-rolling.md): stale-lock detection, retry backoff, and compromise handling are exactly the surface a maintained dependency should own.

**Accept last-write-wins on the single file.** Cheapest to build, and it silently omits real running sessions when two start close together. A listing tool that lies is worse than no listing tool.

**Read the title from the session log in `dsh list-sessions`.** Implemented first, then verified live: the shipped TUI writes `session.jsonl.zstd`, whose frame helpers are internal to the jsonl backend. Exporting them would have hard-coded one backend's file format into the CLI and still shown nothing for SQLite.

**Register the web server itself with a placeholder session id.** `dsh web` owns no session — its sessions are created later by browser clients — so a server row would have put a fake id in a session table. Following session lifecycle instead makes browser sessions appear and disappear as they are opened, which also subsumed the TUI's launcher-side registration and deleted that separate path.

**A `--here`/`--workspace` filter.** Dropped on request: the listing is always global, and narrowing is the user's `grep`.

## Consequences

The registry is an observability aid, so every write is best-effort: a registry fault warns and never fails a working agent session. The cost is that a listing can lag reality by one failed write, healed by the next.

Title mirroring costs one locked read-modify-write per revision, so an aggressive retitling cadence pays that write each time.

`bootId` bounds pid reuse only for records this process wrote. A foreign record whose pid the operating system has reassigned to an unrelated live process is reported alive until its owner removes it — accepted because the portable alternative, reading real process start times, is `/proc`-only.

Liveness is pid existence, not health: a hung process still lists as running. The registry deliberately makes no progress judgement.

## Testing

Unit coverage pins durable-format validation (torn text, foreign version, per-row damage that must not hide siblings), pid pruning against a genuinely reaped pid, `EPERM`-is-alive, incarnation-scoped deregistration, and `retitle` scoping. Both concurrency layers have a regression test verified to fail when its mechanism is removed: 8 real processes for the cross-process lock, 24 overlapping in-process calls for the chain. The publisher is tested over the real `SessionStore` rather than a hand-built emitter, because publication depends on the store's actual lifecycle dispatch.

Verified live in tmux against the assembled application: two concurrent TUI sessions in different workspaces both listed, a title appeared after the first turn, clean exit deregistered, and `SIGKILL` left a stale record that the next `dsh list-sessions` pruned and durably rewrote.
