---
name: dsh-customize
description: Customize or maintain any dsh source checkout — the one powering the current DSH process, the installed `dsh` command, or a sibling dsh/deepseek-harness clone. Use before any requested action that alters such a checkout's files or git state. Read-only questions that only inspect the checkout do not trigger this. Do not edit the personal staging checkout directly.
---

# DSH Customize

Make personal DSH changes in task worktrees and integrate them under the staging lock. Repository instructions still apply.

## Find staging

Do not assume a path or branch name. DSH is usually installed from source with a personal staging branch; create one for the user only when none exists.

1. Inspect `command -v dsh` in the user's launch environment before resolving symlinks.
2. Follow the launcher through the full symlink chain to identify the source checkout. The standard [`scripts/install.sh`](../../scripts/install.sh) keeps every checkout under one container `${DSH_SOURCE}` (default `~/.dsh/source`): the master clone at `${DSH_SOURCE}/master` and each staging checkout as a git worktree `${DSH_SOURCE}/staging-<timestamp>`. `${DSH_BIN_DIR}/dsh` links to `${DSH_SOURCE}/current/bin/dsh`, and the stable `current` symlink points at the active staging worktree, so resolve `current` to reach the real checkout. All paths are configurable; an older install may link PATH straight at a worktree (no `current`) or use scattered sibling clones — follow the launcher rather than assuming a layout.
3. Verify the checkout with Git, then record its branch, tip, status, remotes, worktrees, in-progress operations, and applicable `AGENTS.md` files.
4. Treat the launcher checkout's branch as staging unless the user says otherwise. The installed launcher must resolve to a staging worktree on a staging branch, never the master clone or a task, preparation, review, publication, or detached checkout. Ask if the launcher, checkout, or branch ownership is ambiguous; warn explicitly for a detached HEAD, the master clone, or a non-staging branch.

## Customize

1. Create a fresh task branch and worktree from the recorded staging tip, using the repository-required worktree location — default to `.worktrees/` under the repository root unless the repository requires otherwise. Never implement or commit directly on staging.
2. Implement the change, then select and run the repository-required review and checks. If a check fails, fix the cause and rerun it before integration.
3. For TUI or interactive behavior, test the assembled application interactively in a dedicated tmux session; unit tests and snapshots alone are insufficient.
4. Record the task tip and confirm the task worktree is clean before integration.

## Integrate under the lock

1. Resolve the worktree that owns staging and use `<staging-worktree>/.agents/merge.lock`. Keep it Git-ignored; never remove or replace it. Require `flock`.
2. Acquire the lock, then re-check branch ownership, exact staging tip, clean status, and absence of an in-progress Git operation. If staging moved, unlock and restart discovery against its current owner's lock.
3. Hold the same lock through final precondition checks, `git merge --no-ff`, required post-merge checks, conflict handling, and rollback.
4. If the merge or a post-merge check fails, abort the merge or restore the recorded clean staging tip before unlocking. Never discard unknown user files.
5. Before unlocking, verify staging's branch, commit, clean status, and required checks. Report that evidence and the commands run.
6. Remove the task worktree and branch only when their commits are reachable from staging and no longer needed.

Use [`dsh-upstream-customization`](../dsh-upstream-customization/SKILL.md) when the user wants to contribute a personal feature upstream.
