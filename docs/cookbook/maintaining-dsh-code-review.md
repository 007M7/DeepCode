# Maintaining the dsh-code-review skill

The [`dsh-code-review`](../../.agents/skills/dsh-code-review/SKILL.md) skill is kept current by a single designated operator running a private weekly maintenance tool. This cookbook is the entry point for that operator — and for anyone taking over the role — and for repo contributors who want to understand why skill updates arrive as small periodic PRs rather than one-off audits. The workflow itself is specified in the [human-review skill-maintenance RFC](../rfc/proposed/process/2026-07-13-human-review-skill-maintenance.md).

## What the maintainer receives

On the operator's chosen cadence (currently daily at 10:00 local time, with a two-day overlap window) a private tool runs the workflow the RFC describes:

1. It selects PRs merged in the chosen window (default two UTC days for the daily cadence, seven for weekly) whose merge commit is reachable from `origin/master`. PRs whose merge commit is not reachable (stacked branches whose parent was squashed) or that exceed a 250-commit acquisition cap are logged to `skipped-pulls.json` and skipped rather than aborting the run.
2. It collects pre-merge human review feedback (inline comments, review submissions, PR conversation comments) and post-feedback diff evidence.
3. Two independently configured reviewer adapters classify provenance and adoption, then classify agreed-adopted items against the current skill.
4. The primary adapter drafts a complete revised `SKILL.md`; both adapters review the same diff; blocking findings loop until both approve.
5. `pnpm run doc-sync` and `pnpm run lint` run against the candidate before the tool declares success.

Each run stores its artifacts on the operator's machine. The saved diff and candidate `SKILL.md` land under `~/dsh-code-review-outputs/` named by timestamp; the raw per-adapter I/O, adopted evidence, and consensus/dispute JSON stay in a private temp directory whose path is written to the notification and to the daily log under `~/Library/Logs/dsh-code-review-maintainer/`. The maintenance worktree itself is restored clean after every run so the operator is never tempted to edit the maintenance copy in place.

## What the operator does with a candidate diff

When a run produces a candidate, a macOS notification arrives with a `dsh-code-review-promote <timestamp>` hint.

1. **Read the diff on its own merits.** Do not defer to "the reviewers approved" — the maintainer contract is that the operator is the final judgment. Look for checklist bloat, historical prose, unsupported extrapolation from a single incident, and duplicated coverage with existing skill or authoritative-doc content.

   ```sh
   ls ~/dsh-code-review-outputs/                         # every candidate ever produced
   less ~/dsh-code-review-outputs/2026-07-16T02-00-00Z.diff
   less ~/dsh-code-review-outputs/2026-07-16T02-00-00Z.SKILL.md
   ```

2. **Cross-check against the run artifacts.** Each candidate's per-adapter I/O, consensus, and adopted evidence live under the run's private temp directory (path shown in the log). Spot-check at least one candidate: does the linked human comment actually support the added rule? Does the linked PR actually adopt it?

3. **Decide one of three:**
   - **Discard.** Delete the saved candidate. The tool re-considers the same feedback on the next run under whatever the current skill then says.

     ```sh
     rm ~/dsh-code-review-outputs/2026-07-16T02-00-00Z.{diff,SKILL.md}
     ```
   - **Batch.** Keep the candidate aside if the update is small and could combine with a future one.
   - **Promote.** From a clean `master` checkout of the repo, run the promote helper. It creates a branch, copies the saved candidate over the current skill, commits, pushes, and opens a draft PR — the operator still reviews the PR on GitHub and either merges it or closes it.

     ```sh
     cd ~/path/to/deepseek-harness   # clean master
     dsh-code-review-promote 2026-07-16
     ```

4. **Do not commit adapter output verbatim.** Small edits during promotion — tightening wording, removing an example that only makes sense with the source PR's context, folding a rule into an existing one — are expected and preserve the "reviewer judgment" the workflow depends on. Amend the branch before merging.

## When a run produces no candidate

That is the common case. The tool records "no candidate" in its daily log, sends no notification (to avoid alert fatigue), and moves on. Days without a skill update are the workflow behaving correctly, not a stall.

## Interruptions and handoff

The mechanism lives on one machine. Interruptions the operator handles as they arise:

- **Daily run missed.** The two-day overlap window catches one skipped day automatically; longer gaps recover by running the wrapper manually with `DSH_CODE_REVIEW_SINCE=<Nd>`. Overlapping windows are idempotent: guidance already in the current skill is classified `covered` and does not re-enter as a candidate.
- **Adapter provider outage.** The tool refuses to run when the two reviewer commands resolve to byte-identical executables. A single batch whose adapter response fails schema or id validation is failed closed at the batch level (every item in the batch marked unclear) and the run continues; the raw output is preserved for debugging. A total-provider outage that fails every batch produces a "no candidate" result — retry after the provider is restored.
- **Handoff to another maintainer.** Open a follow-up RFC that supersedes the current one: either move the mechanism into the repository or record the new operator's private setup. Do not silently transfer the tool — the "single-maintainer bus factor" in the RFC's Risks section is the reason the handoff needs a documented decision.

## Where the operator's private setup lives

The tool source, reviewer adapters, provider credentials, and scheduler are the operator's private infrastructure and are outside this repository by design (see the RFC's "Where the mechanism lives" section). This cookbook and the RFC describe **what the workflow guarantees**; **how** those guarantees are implemented is a private-infrastructure concern. If you are the new operator, the RFC's `## Proposal` sections are the specification you build against.
