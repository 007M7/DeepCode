# Agent Note: source-guard denies direct staging-checkout edits

Status: implemented

English | [中文](2026-07-28-source-guard-staging-edit-gate.zh.md)

## Problem

The [`dsh-customize`](../../../../skills/dsh-customize/SKILL.md) skill governs every personal change to a dsh source checkout: implement in a task worktree branched from the staging tip, then integrate under `.agents/merge.lock`. Its central rule is negative — do not edit the personal staging checkout directly — and a negative rule delivered only as prompt text fails in exactly the case that matters. An agent that never loads the skill never sees the rule, and one that loads it early can still forget it thirty tool calls later. The failure is silent and expensive: commits land on the staging branch that the launcher runs from, outside any task branch, with no lock held and no rollback worktree.

Prompt guidance cannot fix this, because the guidance is what went unread. The rule needs an enforcement point.

## Decision

`@deepseek-ai/dsh-source-guard` (`packages/guard/source-guard/`) is a `tools/pre-execute` listener that returns `{kind: 'deny', reason}` for a `write` or `edit` whose target resolves inside a protected staging worktree, unless the calling session's durable log already records a successful `skill` call naming `dsh-customize`. It registers no service and contributes no prompt text or tool schema; an allowed call is indistinguishable from one made without the plugin. It is not in any shipped default composition.

### Git identity from files, not a path prefix and not `git`

Whether a path is protected is decided by reading `.git`, its `gitdir:` pointer, and `HEAD`. Three shapes resolve: a plain clone (`.git` is a directory that is its own common dir), a linked worktree (`.git` is a file pointing at `<common>/worktrees/<name>`, whose common dir is two levels up), and a detached HEAD (`HEAD` holds a raw object id and names no branch). A `gitdir:` pointer resolves whether absolute — what `git worktree add` writes — or relative, which git resolves against the worktree directory holding it.

Denial requires the target's worktree to match the launcher's on both identities: the same shared git directory and the same branch. Both come from resolving `protectedCheckout`, so nothing about the protected branch is configured. An earlier revision matched a `dsh-staging/*` name pattern instead; the exact-branch rule replaced it because a pattern is wrong in both directions. It denied every sibling staging worktree an old install had left behind, none of which runs a launcher, and it silently protected nothing for a maintainer whose staging branch follows no naming convention — a fatal property for a shipped default that must hold for checkouts [`scripts/install.sh`](../../../../scripts/install.sh) did not create.

A path-prefix rule would have been wrong, not merely imprecise. The task worktrees the skill prescribes live *inside* the protected tree at `<staging>/.worktrees/...`, so a prefix rule would deny every edit the workflow requires. Resolution walks outward from the target and stops at the first enclosing worktree, so it reports the innermost one: a nested task worktree answers with its own task branch and is allowed, while the launcher's own tree answers with the launcher's branch and is denied.

Two path details decide whether the gate holds at all, and both are enforcement, not polish. Repository identity is compared on symlink-resolved paths (`canonicalPath` from `dsh-sandbox`), because a session cwd under `/var/...` and a configured path under `/private/var/...` are the same macOS directory and a lexical comparison would fail open on every write. And a relative `file_path` is resolved against the calling session's workspace, exactly as `dsh-tool-fs` resolves it; judging only absolute paths would have left a relative path as an unguarded route to a protected file.

`protectedCheckout` names a path inside the guarded checkout, defaulting to this module's own file. That resolves the checkout the running harness was launched from — the live deployment, whatever its branch is named. A harness running from an installed copy resolves a different repository, or none, and guards nothing; the rule is meaningless outside a source checkout.

The shipped TUI composition loads the plugin with these defaults, so every source install is protected without configuration. It is inert for an ordinary project: a workspace in another repository, or none, never matches the launcher's identities.

### Satisfaction replayed from the durable log

The gate lifts on a `tool/call` naming the `skill` tool whose arguments parse to `{name: <requiredSkill>}`, paired by call id with a non-error `tool/result`. Both fields are already durable (`packages/core/session/src/types.ts`), so this needs no new session event and no coupling to skill-provider internals.

The log is the only state. In-memory satisfaction (the `WeakMap` shape [`repeat-tool-guard`](../../archived/feature/2026-07-08-repeat-tool-guard.md) uses for its chains) would be smaller, but it loses satisfaction on resume: a resumed session that already read the skill would be told to read it again, and the denial would look like a bug rather than a rule. Replay costs a scan bounded by the first hit and buys resume correctness.

### Fail open, deliberately

A path outside any worktree, a detached HEAD, a foreign repository, a malformed `gitdir:` pointer, and unreadable metadata all leave the call to the rest of the chain. The alternative — denying whenever git identity is unavailable — converts any `.git` permission problem into a harness that cannot write files at all. The guard exists to prevent one specific, recoverable mistake; it must not become a larger outage than the mistake.

### Narrow scope

`read` is never gated: inspecting staging violates nothing, and the skill explicitly permits read-only questions. `bash` is not gated either. Reliably classifying mutating shell commands is a matcher problem with no honest completion condition, so a determined model can still change staging through a shell. This is a boundary against forgetting, not a sandbox against intent.

## Alternatives considered

- **Advisory reminder instead of denial** (`additionalContexts` on `tools/post-execute`, the `repeat-tool-guard` shape). Rejected: the write has already happened when the reminder arrives, so the violation is committed and the guidance is again just text.
- **`{kind: 'ask'}` routed to approval.** Rejected: it prompts on every legitimate task-worktree edit in the common case, and degrades to denial in a composition without approval support, making behavior depend on unrelated plugins.
- **Running `git rev-parse` through `ctx.subprocess`.** Rejected after measuring the alternative: two file reads answer the same question with no process spawn per gated write, no `git` on `PATH` requirement, and no subprocess dependency. Reading `.git` and `HEAD` is a stable on-disk format, not an implementation detail.
- **Explicit `protectedRoots` config with no detection.** Rejected: it makes the common case require configuration to be correct, and a stale absolute path silently disables protection.
- **A configurable staging-branch name pattern** (`stagingBranchPatterns`, default `dsh-staging/*`). Shipped first, then removed: it protects the wrong set in both directions — every stale sibling worktree that runs no launcher, and nothing at all for a maintainer whose branch is named otherwise. Deriving the branch from the launcher needs no configuration and cannot be misconfigured.
- **Auto-detecting the checkout with no override.** Rejected: the detection is a default, not a law; a deployment guarding a different checkout, or running from an installed copy, needs the explicit value.
- **Denying everything under the checkout root, `.worktrees/` included.** Rejected: it blocks the workflow the skill prescribes, so the guard would fire on every legitimate task edit.
- **Gating `bash` with a mutating-command matcher.** Deferred, not rejected: worth revisiting if bypasses are observed in practice. A matcher that is wrong in either direction is worse than an honestly narrow gate.

## Consequences

The rule now holds without depending on the model having read it, and the denial names the path, the branch, and the skill, so the model's next action is determined rather than guessed. Enforcement sits at the operation boundary that owns the decision, so it cannot be bypassed by prompt filtering or listener order.

Shipping it in the TUI default means every source install is protected without configuration, and the protection follows the launcher across upgrades because the branch is derived rather than named. The cost of that reach is that the plugin loads for every user, including those whose workspace it can never match.

What it cost otherwise: the guard is only as complete as its tool list, and `bash` remains open. Worktree identity is cached per directory for the plugin's lifetime, so a mid-session branch switch is not observed on either side. Only the launcher's own checkout is protected, so a stale sibling stays editable. Loading the skill lifts the gate for the whole session without verifying the workflow was actually followed — the gate proves the instructions were read, not obeyed. Satisfaction is per session, so a subagent with its own session must load the skill itself.

## Testing

Unit suites drive a real agent loop against a mock adapter over real git-metadata fixtures — a staging worktree, a task worktree nested inside it, a plain clone, a foreign repository on a staging-named branch, a detached HEAD, absolute and relative `gitdir:` pointers, a symlinked route to one repository, a malformed pointer, and unreadable metadata — covering both source files to per-file 100%. A companion `invariant.ts` validates the durable denial's shape, since the refusal text is the package's only model-visible output and is actionable only when it names the path, branch, and skill.

The real-composition smoke boots `examples/headless-agent/tests/fixtures/guard/source-guard/cordis.yml` through the Loader and the headless app, and asserts three things about the assembled run: the tool result is an error, its text is the exact denial, and the targeted file still holds its original bytes — enforcement before dispatch, not advice after it.

An ACP snapshot scenario (`source-guard-staging-deny`) originally owned the assembled transcript, seeding a staging worktree in the harness's generated cwd through a new `Scenario.prepareCwd` hook — git never tracks an entry named `.git` and `.gitignore` excludes every `worktrees/` directory, so the fixture committed the two `HEAD` bodies and the hook assembled the real layout. Authoring it paid for itself immediately: it exposed both path defects above (the transcript showed `fs-policy` answering first wherever the guard had quietly declined to judge) and then caught its own first fixture, whose ignored `worktrees/` path passed locally from an untracked file. The scenario was later removed with the assembled-run evidence consolidated into the Loader-composition smoke; the `prepareCwd` hook it introduced remains part of the snapshot harness for repository-shaped fixtures.

## Related

- [The personal-staging maintenance skills Agent Note](../process/2026-07-23-personal-staging-maintenance-skills.md) — the workflow this gate enforces one rule of. That note owns the skills' content and discovery; this one owns the enforcement point and holds no authority over the workflow itself.
- [The interception-seams Agent Note](2026-06-30-interception-seams.md) — the `tools/pre-execute` `allow`/`deny`/`ask` vocabulary this gate's denial uses.
- [The repeat-tool-guard Agent Note](../../archived/feature/2026-07-08-repeat-tool-guard.md) — the sibling guard whose advisory shape this one deliberately does not take.
