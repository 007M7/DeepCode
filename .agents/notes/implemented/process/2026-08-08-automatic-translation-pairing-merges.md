# Agent Note: Automatically compose translation pairing records

Status: implemented

English | [中文](2026-08-08-automatic-translation-pairing-merges.zh.md)

## Problem

A bilingual consistency record contains the two owner files' exact blob hashes. Two branches that independently update different parts of the same confirmed pair therefore conflict on both hash lines even when Git cleanly composes both Markdown owners. Selecting either side leaves stale hashes, while regenerating the record by hand repeats a deterministic operation and prevents an otherwise automatic merge.

## Decision

`*.i18n.yaml` uses the repository-owned `dsh-translation-pairing` merge driver. The worktree-local Git installer registers its command alongside Lefthook setup; Git configuration remains local because a tracked attribute can name a driver but cannot carry its executable command.

The driver parses the ancestor, current, and other records and loads the six owner blobs named by their hashes. It independently runs Git's default three-way text merge for the English and Chinese triplets, requires both merges to be clean, verifies language switchers and the pairing structural signature, stores the two merged blobs, and writes their hashes as the canonical record. This composes confirmations already present in both parents; it never records an ordinary one-sided documentation edit.

The driver fails with an ordinary unresolved sidecar when a record is malformed, an object is missing, an owner uses another merge strategy, either owner has content conflicts, or the merged pair violates structural checks. Add/delete and rename shapes remain manual because their path ownership is not the same three-record operation.

`pnpm run resolve-translation-pairing-conflicts` applies the same algorithm after a merge has already stopped. Before writing any sidecar, it proves that the staged owner blob IDs and working-tree bytes equal its independent merges; then it writes and stages every safe record as one batch while leaving unrelated conflicts untouched.

`pre-merge-commit` and `pre-commit` verify staged `.i18n.yaml` files against the exact index bytes of their owners. They validate driver output but do not regenerate records, so bypassing a hook cannot silently bless translation drift; the corpus-wide `doc-sync` check remains authoritative in CI.

## Verification

Script tests exercise clean composition through a real custom-driver Git merge, explicit recovery from an unresolved index, owner-content conflicts, record parsing, and worktree-local installation. The existing corpus verifier continues to prove that a committed record matches its two owners.

## Alternatives considered

**Take ours or use Git's union driver.** Either parent record names pre-merge content, while union produces duplicate or unordered hash keys. Neither represents the merged owners.

**Regenerate in `post-merge` or only in a commit hook.** `post-merge` does not run after a conflicted merge and cannot affect its outcome. Commit hooks are reached only after the index has no unresolved entries, so a hook alone cannot clear the generated conflict.

**Wrap every merge in a repository command.** A wrapper can resolve the conflict from the populated index, and the explicit resolver retains that recovery path, but raw Git, stack tooling, rebases, and cherry-picks would still stop before it. The merge driver is the file-level extension point shared by those operations.

**Resolve on GitHub through Actions or an app.** Hosted automation could update PR branches, but it adds credentials, concurrency control, and branch mutation. Local and agent-driven merge-forward workflows already have a checkout and push authority; the repository keeps remote automation out of this mechanism.

## Consequences

Installed worktrees automatically remove pairing-record-only conflicts while preserving human judgment for owner conflicts and translation quality. GitHub's hosted mergeability calculation does not run the worktree-local executable, so a contributor or agent must still merge the base and push the resulting commit before the remote conflict badge clears.

The installer reserves `merge.dsh-translation-pairing.*` in worktree configuration and refuses a conflicting custom value. Merge execution depends on the installed Node dependencies, like the repository's contributor hooks; missing setup fails rather than selecting stale metadata.
