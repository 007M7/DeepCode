# RFC: Resolve filesystem paths against the caller's session cwd

Status: implemented

## Problem

The ACP bridge gives every session its own workspace: `session/new` records the editor's project directory as `SessionHeader.cwd`, and `dsh-tool-bash` defaults each bash call's `workdir` to the calling agent's `session.header.cwd` (see [the per-session cwd RFC work in `packages/ui/acp`](../../../../packages/ui/acp) and `resolveWorkdir` in `dsh-tool-bash`). So a bash command in session A runs in A's project, and in session B runs in B's — one server process, N workspaces.

The filesystem tools did NOT honor this. `ctx.fs.resolve(path)` took no caller context, and `dsh-fs-local` resolved every relative path against a single `config.cwd` fixed at plugin load (`process.cwd()`). In the ACP demo that means `write foo.txt` and `bash cat foo.txt` resolve `foo.txt` against **different** directories — the fs tools against the server's launch dir, bash against the session's project dir. The two tools disagree about what "the current directory" is, which is a correctness bug the moment an editor opens any project other than the server's launch dir. It only appeared to work in the snapshot harness because that harness launches the child process in the same temp dir it passes as the session cwd, so the two coincide.

## Decision

Thread the caller's session cwd into path resolution, exactly as `dsh-tool-bash` already does for `workdir`. The **caller** (the tool) supplies the cwd; the provider does not read a session or agent.

- `FileSystem.resolve` widens to `resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget>`. `opts.cwd` is the base a RELATIVE `path` resolves against; an absolute `path` ignores it; omitting `opts.cwd` uses the backend's own default. An options object (not a positional `cwd?`) leaves room for future resolution hints without another signature change.
- `dsh-fs-local.resolve` uses `resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)`. `config.cwd` stays the default for a caller that supplies none (non-ACP / no-session use, and the single-session stdio demo where `process.cwd()` IS the workspace).
- `dsh-tool-fs`'s `read`/`write`/`edit` derive the session cwd through a shared `sessionCwd(exec)` helper (`exec.agent?.session.header.cwd`, mirroring bash's `resolveWorkdir`) and pass it to `resolve`. A non-agent / headerless caller yields `undefined`, so the backend applies its default.

## Why the caller supplies the cwd (not the provider)

The provider seam must not depend on `dsh-agent` / `dsh-session` — it is a text-storage backend that a sandboxed or remote implementation also satisfies, and those have no notion of an "agent session". The tool already receives the `ToolExecution` (`exec`), which carries the agent, so the tool is the right place to project `exec → cwd` and hand the provider a plain string. This is the "explicit > implicit at package seams" convention: the base directory arrives as an explicit argument the provider acts on, not smuggled in by having the provider reach into a session it should not know about. It also matches `dsh-tool-bash` one-to-one, so the two model-facing file surfaces resolve paths identically.

The default lives in ONE place — the provider's `config.cwd`. `sessionCwd` returns `undefined` rather than `process.cwd()` when there is no session, so the tool never manufactures a base the provider would otherwise choose.

## Consequences

- In the ACP demo the fs tools and bash now agree on each session's workspace; an editor can open any project folder and both tool families act on it.
- No change to `FsTarget` identity: `targetKey` is still the realpath of the resolved absolute path, so observed-state keying and symlink identity are unaffected — a correct per-session cwd produces the same key bash targets.
- Backward compatible: every existing `resolve(path)` call (all in tests) keeps working; the new argument is optional.
- The single-session stdio demo is unaffected: it supplies no session cwd (its agent's session has no `cwd`), so resolution falls back to `config.cwd = process.cwd()`, which is the workspace.
