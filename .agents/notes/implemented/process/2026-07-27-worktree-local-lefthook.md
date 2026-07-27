# Agent Note: Make Lefthook installation worktree-local

Status: implemented

English | [中文](2026-07-27-worktree-local-lefthook.zh.md)

## Problem

Every `pnpm install` runs the root [`postinstall`](../../../../package.json), whose [`install-lefthook.mjs`](../../../../scripts/install-lefthook.mjs) invokes `lefthook install --force`. Linked Git worktrees otherwise share the common repository's default hooks directory, so an install in any worktree can rewrite hooks used by every other worktree.

Lefthook-generated hooks prefer an absolute binary path captured from the installing worktree before trying their current-worktree fallback. Shared hooks can therefore run another worktree's pinned binary until that worktree disappears, while concurrent installs write the same files.

## Decision

Hook installation is worktree-scoped. With `CI=true`, the installer returns before Git discovery or mutation because automated jobs do not consume contributor hooks. Otherwise, it requires Git 2.26 or newer for configuration-scope provenance, upgrades a format-0 repository to format 1, enables `extensions.worktreeConfig`, and assigns the current worktree an absolute `core.hooksPath` at `$GIT_DIR/dsh-hooks`. Before first enabling the repository-wide extension, it inspects the dormant `config.worktree` file for the main worktree and every registered linked worktree, then refuses any settings whose activation would change the current or a sibling worktree. The main worktree receives `$GIT_COMMON_DIR/dsh-hooks`; each linked worktree receives the corresponding directory under `$GIT_COMMON_DIR/worktrees/<id>`. A repository-scoped lock serializes configuration migration and hook writes, including repeated concurrent installs. Each lock records a process ID and random ownership token; release verifies the same file identity and exact record. A dead or invalid lock is never broken automatically, so the diagnostic requires the contributor to confirm no installer is running and remove the lock manually.

The installer recognizes its hook directory with a private ownership marker and updates it idempotently. It inspects the effective scope, origin, and value of `core.hooksPath`, then refuses an unowned directory, every command-scoped path, and every non-owned worktree-scoped path, including values loaded through `config.worktree` includes. It follows conditional includes with Git's parser and refuses a command- or worktree-scoped include whose target provides, or cannot safely be shown not to provide, a hook path; an inactive condition therefore cannot later hide a user-owned path behind the installer's direct value. The same risk in an inherited system, global, or common-repository include requires `DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1`, which explicitly opts only the current worktree into Lefthook while other worktrees retain the inherited path. Unrelated conditional includes remain valid. Command-scoped Git configuration is removed from the Lefthook subprocess environment after validation. This opt-in does not attempt to chain arbitrary hook managers.

Enabling worktree config removes the standard redundant `core.bare=false` value from the common config because false remains Git's default; an explicit `core.worktree` or `core.bare=true`, whether direct or loaded through an active common-config include, is refused for manual migration. Before enabling the extension, the installer follows common-config conditional includes and refuses a target that provides, or cannot safely be shown not to provide, either migration-sensitive key; unrelated conditional includes remain valid. If Lefthook fails during a first install, the installer removes the new worktree override so the prior inherited or common hooks remain active. Legacy files in `$GIT_COMMON_DIR/hooks` are never removed or rewritten by the worktree-local installer.

[`install-lefthook.spec.ts`](../../../../scripts/install-lefthook.spec.ts) exercises the CI no-op, main and linked worktrees, removal independence, repeated and concurrent installs, stale and replaced lock ownership, the Git version boundary, dormant sibling-config refusal, migration keys loaded through active and conditional common-config includes, scoped custom-path refusal and opt-in, active and inactive worktree includes, inherited conditional paths, command-environment isolation, legacy common-hook preservation, and failed-install rollback.

## Alternatives considered

**Keep the shared generated hooks and rely on their current-worktree fallback.** The captured absolute path wins while its worktree exists, so the fallback does not provide version or lifecycle isolation.

**Point every worktree at one checked-in `.githooks` directory.** A relative tracked directory removes generated absolute paths, but changing the shared `core.hooksPath` can disable hooks in older worktrees whose branches do not contain that directory and still couples every worktree to one shared configuration value.

**Build a general hook-manager chaining layer.** Ordering, argument forwarding, failure semantics, and upgrades become repository-owned behavior unrelated to Lefthook isolation. The installer instead refuses worktree-specific custom paths and makes the narrower inherited-path override explicit.

**Whitelist provider-specific CI credential-include paths.** Contributor hooks are unused in CI, so path exemptions would couple installer safety to provider checkout internals and weaken strict validation for contributor installs. The CI no-op avoids repository mutation without any exemptions.

**Stop installing hooks automatically.** Manual setup avoids shared writes but makes the repository's cheap commit and push checks optional by accident, especially in short-lived agent worktrees.

## Consequences

Installing or removing one worktree no longer changes another worktree's active hooks, binary path, or generated hook bytes. Concurrent installs are serialized and repeated installation is idempotent, while the jobs and latency boundary owned by [Fast local Git hooks](2026-07-22-fast-local-git-hooks.md) stay unchanged.

The repository becomes a Git format-1 repository after the first installation and rejects clients older than Git 2.26. Custom worktree hook managers require an explicit integration choice; inherited hook paths can coexist across other worktrees, but opting the current worktree into Lefthook means those inherited hooks do not run there unless the contributor chains them through `lefthook.yml`.

Legacy common hooks remain on disk for unupgraded worktrees. They can become stale, but removing them automatically would break a registered worktree whose branch has not adopted this installer.
