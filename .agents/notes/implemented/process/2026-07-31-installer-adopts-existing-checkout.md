# Agent Note: the installer adopts an existing checkout into the managed layout

Status: implemented

English | [中文](2026-07-31-installer-adopts-existing-checkout.zh.md)

## Problem

`scripts/install.sh` produced two incompatible install shapes. A `curl … | sh` install built the managed layout — a master clone at `~/.dsh/source/master`, a staging worktree on `dsh-staging/<timestamp>`, and the stable `current` symlink the PATH launcher resolves through. Running the same script from a checkout instead linked `dsh` straight at that checkout's `bin/dsh`, per the earlier [in-repo skip-clone decision](../../archived/process/2026-07-22-installer-in-repo-skip-clone.md).

The direct link is a terminal state. `current` is what an upgrade repoints, so an install without it is not upgradable by [`dsh-upgrade`](../../../../skills/dsh-upgrade/SKILL.md); the PATH symlink dangles if the checkout moves; and the launcher resolves to whatever branch the contributor happened to have checked out, which the upgrade contract forbids as a launcher target. The upgrade skill already described this shape as a legacy install needing a one-time migration, so the layouts diverged at install time and were reconciled only later, if ever.

## Decision

In-repo mode still never clones and never modifies the working tree, but it now offers to **adopt** the checkout into the managed layout, and adoption is the default.

The container owns staging worktrees and `current`; the repository is *discovered*, not owned. `git rev-parse --git-common-dir` resolves the shared git directory behind the checkout — for a linked worktree that is the real clone rather than the worktree itself — and its parent is the repository that serves as the upgrade base. A staging worktree branched from the checkout's `HEAD` is then created under `$DSH_SOURCE`, and `current` points at it. A clone anywhere on disk therefore converges on the same layout as a `curl` install, and the two paths share one worktree/exclude/lock/link sequence: they differ only in whether the repository was discovered by `git clone` or by `git rev-parse`.

`$DSH_SOURCE/master.path` records the resolved repository, and only when that repository lives outside the container. A container holding its own master is self-contained and gets no file, so the file's presence is itself the signal that this container depends on an outside path: each staging worktree holds an absolute gitdir pointer into that clone, so deleting the clone breaks them.

Adoption branches from `HEAD`, so committed work is what runs and uncommitted changes stay in the checkout; a dirty tree is warned about before the prompt and whenever `DSH_ADOPT=1` skips it. Declining, or `DSH_ADOPT=0`, keeps the previous link-in-place behavior with a warning naming what it costs, because that path is what makes this script testable against local source. A repository with no commits cannot be branched and falls back to link-in-place; a checkout that is not a git repository fails with the `DSH_ADOPT=0` escape hatch named.

`DSH_ADOPT=1` also overrides the rule that an explicit `DSH_SOURCE` opts back into cloning. Naming a container while asking for adoption otherwise silently cloned a different tree — the opposite of the request.

Every path comparison runs on physical paths through a `resolve_dir` helper, and every compared value is resolved at assignment rather than at the comparison. macOS resolves `/var` through a symlink to `/private/var`, so comparing a git-reported path against an unresolved one misclassified an existing managed install as a foreign clone and would have built a second container beside the real one. The same defect recurred twice more during review — once where a curl install's `REPO_ROOT` stayed unresolved and wrote a spurious `master.path`, and once where `x=$(resolve_dir …) || x=$fallback` left an empty path because the assignment succeeds even when the substitution fails. `resolve_dir` therefore echoes a missing path back itself, and callers that need "does not exist" test the directory explicitly. `git rev-parse --path-format=absolute` would do the same job but requires git 2.31+.

Before `current` is repointed, the installer rejects a staging path that resolves to the repository itself, enforcing the upgrade contract that the launcher never resolves to the master clone.

## Alternatives considered

**Make `~/.dsh/source/master` a symlink to the arbitrary clone.** Rejected. Git resolves the symlink and records the *real* path: a worktree created through it stores `gitdir: …/<clone>/.git/worktrees/<name>`, and `git worktree list` reports the clone. The symlink is therefore decorative — nothing reads it — while implying the container owns the repository. It also fails silently: moving the clone leaves `master` present but dangling and every staging worktree dead with `fatal: not a git repository`. Worst, it aliases two names onto one tree, so the "current must never be the master clone" check passes by string comparison while being false. `~/.dsh/source/master` is a location, not a name, and only the location is authoritative.

**Promote the checkout itself to the `current` target.** Rejected: the upgrade contract requires `current` to be a clean staging worktree on a staging branch, never a feature, review, or detached checkout. It would also make every upgrade rewrite the tree the contributor is editing.

**Keep adoption opt-in.** Rejected as the default: the divergent shape was the actual defect, and leaving the fix behind a flag means the common `sh scripts/install.sh` invocation keeps producing unupgradable installs. Declining is one keystroke and `DSH_ADOPT=0` is scriptable.

**Put an adopted clone's staging worktrees beside the clone** (`~/src/staging-*`) rather than in `~/.dsh/source`. Rejected: `current` and the PATH launcher are per-user singletons, so scattering worktrees across clone parents reintroduces the sibling-clone sprawl the source container exists to prevent.

## Consequences

One layout now serves both installs, so an adopted clone is upgradable by `dsh-upgrade` without the one-time migration that skill described. In-repo runs still never mutate the working tree, and the escape hatch that keeps this script testable against local source survives behind a prompt and `DSH_ADOPT=0`.

The cost is that a container adopting an outside clone is no longer self-contained: deleting that clone breaks its staging worktrees. This is inherent to reusing an existing clone rather than a property of this design — the rejected symlink hides it rather than fixing it — and `master.path` is the mitigation, not a repair.

## Testing

`scripts/install.sh` has no automated test, and this change does not add one: the user directed that `install.spec.ts` be left out of scope. That is a known gap on a shipped user-facing path, and the `/var` resolution defect above is exactly the class of bug a test would have caught first. The standing [`FIXME(install-ts)`](../../../../scripts/install.sh) asking for this workflow to move into a tested TypeScript entrypoint is correspondingly more pressing.

Verification was manual, through a throwaway harness driving the real script with a stubbed `pnpm`: adopting a standalone clone; adopting from a linked worktree into its existing container; `DSH_ADOPT=0` preserving link-in-place; a commitless repository falling back; a dirty tree warning while leaving uncommitted work behind; a non-git checkout failing with guidance; and a `curl`-style clone install asserting both the built layout and the absence of `master.path`, which is the regression that caught the unresolved-`REPO_ROOT` defect. Both interactive outcomes were exercised under tmux: accepting ends with the launcher running from the new staging worktree while the original checkout keeps its branch and clean status, and declining reproduces the legacy shape with no staging worktree and no `current`.
