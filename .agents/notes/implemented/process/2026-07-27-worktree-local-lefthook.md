# Agent Note: Make Lefthook installation worktree-local

Status: implemented

English | [中文](2026-07-27-worktree-local-lefthook.zh.md)

## Problem

Every `pnpm install` runs the root [`postinstall`](../../../../package.json), whose [`install-lefthook.mjs`](../../../../scripts/install-lefthook.mjs) invokes `lefthook install --force`. Linked Git worktrees otherwise share the common repository's default hooks directory, so an install in any worktree can rewrite hooks used by every other worktree.

Lefthook-generated hooks prefer an absolute binary path captured from the installing worktree before trying their current-worktree fallback. Shared hooks can therefore run another worktree's pinned binary until that worktree disappears, while concurrent installs write the same files.

## Decision

Hook installation is worktree-scoped. The installer requires Git 2.20 or newer, upgrades a format-0 repository to format 1, enables `extensions.worktreeConfig`, and assigns the current worktree an absolute `core.hooksPath` at `$GIT_DIR/dsh-hooks`. The main worktree receives `$GIT_COMMON_DIR/dsh-hooks`; each linked worktree receives the corresponding directory under `$GIT_COMMON_DIR/worktrees/<id>`. A repository-scoped lock serializes configuration migration and hook writes, including repeated concurrent installs.

The installer recognizes its hook directory with a private ownership marker and updates it idempotently. It refuses an unowned directory or a worktree-specific custom `core.hooksPath`. An inherited global or common-repository hook path is preserved by default; `DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1` explicitly lets only the current worktree override it, so worktrees without that override continue using the inherited path. This opt-in does not attempt to chain arbitrary hook managers.

Enabling worktree config removes the standard redundant `core.bare=false` value from the common config because false remains Git's default; an explicit `core.worktree` or `core.bare=true` is refused for manual migration. If Lefthook fails during a first install, the installer removes the new worktree override so the prior inherited or common hooks remain active. Legacy files in `$GIT_COMMON_DIR/hooks` are never removed or rewritten by the worktree-local installer.

[`install-lefthook.spec.ts`](../../../../scripts/install-lefthook.spec.ts) exercises main and linked worktrees, removal independence, repeated and concurrent installs, the Git version boundary, custom-path refusal and opt-in, legacy common-hook preservation, and failed-install rollback.

## Alternatives considered

**Keep the shared generated hooks and rely on their current-worktree fallback.** The captured absolute path wins while its worktree exists, so the fallback does not provide version or lifecycle isolation.

**Point every worktree at one checked-in `.githooks` directory.** A relative tracked directory removes generated absolute paths, but changing the shared `core.hooksPath` can disable hooks in older worktrees whose branches do not contain that directory and still couples every worktree to one shared configuration value.

**Build a general hook-manager chaining layer.** Ordering, argument forwarding, failure semantics, and upgrades become repository-owned behavior unrelated to Lefthook isolation. The installer instead refuses worktree-specific custom paths and makes the narrower inherited-path override explicit.

**Stop installing hooks automatically.** Manual setup avoids shared writes but makes the repository's cheap commit and push checks optional by accident, especially in short-lived agent worktrees.

## Consequences

Installing or removing one worktree no longer changes another worktree's active hooks, binary path, or generated hook bytes. Concurrent installs are serialized and repeated installation is idempotent, while the jobs and latency boundary owned by [Fast local Git hooks](2026-07-22-fast-local-git-hooks.md) stay unchanged.

The repository becomes a Git format-1 repository after the first installation and rejects clients older than Git 2.20. Custom worktree hook managers require an explicit integration choice; inherited hook paths can coexist across other worktrees, but opting the current worktree into Lefthook means those inherited hooks do not run there unless the contributor chains them through `lefthook.yml`.

Legacy common hooks remain on disk for unupgraded worktrees. They can become stale, but removing them automatically would break a registered worktree whose branch has not adopted this installer.
