# Responding to review across a stacked PR chain

A wave of review comments lands across several PRs in a dependent stack (`A ← B ← C …`). This is the discipline for resolving it without corrupting the stack. The two invariants it rests on are standing orders in the root [AGENTS.md](../../AGENTS.md) § Conventions: merge commits only, and never rewrite a pushed branch.

## Ground rules

1. **One worktree per PR branch.** Each PR's fixes happen in that PR's own worktree; parallel fixes never share a checkout.
2. **Bring a child up to date by merging the parent down** (`git merge <parent-branch>` into the child, a new merge commit). Never rebase/amend/force-push a pushed branch: rewriting diverges it from what the parent PR and GitHub recorded, breaks the stacked-merge graph, and erases the review-fix history.
3. **A fix lands on the PR that INTRODUCED the issue, then flows down.** When a comment on PR `B` points at code `B` introduced, fix it on `B` and merge `B` into `C` — even if `C` also carries the file. Originating the fix downstream leaves `B` shipping the unfixed code and hides the fix from `B`'s reviewer.
4. **Each review fix is a separate commit, never an amend.** The "fix review findings" commit documents what the review caught. Amending is fine only for your own not-yet-pushed, not-yet-reviewed work.

## Working the wave

1. Triage every comment on the merits before acting: verify the claim against the code — a reviewer flagging the right symptom can still mis-diagnose the cause.
2. Map each accepted finding to its originating PR, fix it there, then merge down the chain in order.
3. Delegated fixes are trust-but-verify: a sub-agent's report describes intent, not necessarily what landed. Re-run the gates yourself on the actual tree, and for a regression guard, prove it FAILS on the unfixed code (introduce the regression, watch red, revert) — a guard that passes both ways guards nothing. A sub-agent that reframes a problem as already-handled is a signal to dig in personally.
4. Reply in the review thread (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`), not as a top-level comment, stating the fix and the commit that carries it.
5. Before merging the stack, check dependents: deleting a PR's base branch auto-closes the dependent PR — `gh pr list --json number,baseRefName` first, and merge without `--delete-branch` where a child still bases on the branch.

## Verify

- Every fixed PR shows a new commit (no force-push icon in the PR timeline).
- Each child PR's diff against its parent still shows only its own changes.
- The gates pass on every PR in the stack, not just the top.
