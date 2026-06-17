---
name: dsh-code-review
description: Use when reviewing a pull request in the deepseek-harness repo — orients the reviewer to this codebase's standards (AGENTS.md conventions, defensive patterns, ADRs, quality gates) and the review-specific checks that code alone can't show
---

# Reviewing a DeepSeek-Harness PR

**This skill is guidance, not a complete checklist.** It is a where-to-look map that lowers your startup cost on an unfamiliar PR — clearing every item here does not mean the PR is good. You are the reviewer: reason independently from the code in front of you, and think broadly across every dimension a change can fail on. The items below are the failure modes this repo has already paid for; a real review also catches the ones nobody has written down yet.

Independent judgment governs *what to look at* and *how to apply a rule to this case* — not whether the repo's documented requirements still hold. AGENTS.md, packages/AGENTS.md, and the [ADR 0007 quality gates](../../../docs/adr/0007-quality-gates.md) remain authoritative; a missing HMR-safety test or out-of-sync docs is a blocking gap regardless of your judgment, not a suggestion you can waive. Use your own reasoning to go *beyond* these checks and to weigh genuine edge cases against an ADR (raise it as a discussion, don't silently override) — never to demote a documented blocker to optional.

## How to think about a review

- **Reason from the code, not from this list.** Read the diff and enough surrounding context to understand what the change actually does, then ask what could go wrong — independently of whether this skill names it. The named patterns are a floor, not a ceiling.
- **Think broadly, across many aspects.** A change can be wrong in correctness, concurrency/lifecycle, error handling, security, performance, API/contract design, type safety, test quality, docs sync, naming, readability, or backward compatibility. Also challenge the *approach itself*: is this the right design, are its assumptions sound, where does it fail under real-world conditions? Don't tunnel on the first defect you spot or stop at the checklists below — sweep all of them.
- **Verify before you flag.** Check a suspected issue against the actual codebase (grep the symbol, read the caller, confirm the path is reachable) before raising it. An unverified claim wastes the author's time and erodes trust in the review.
- **Calibrate confidence; suppress noise.** Distinguish a blocking bug from a nitpick and say which is which. Don't raise things a gate already enforces (typecheck, lint, formatting, type errors, broken tests), pre-existing issues on lines the PR didn't touch, or pedantic style a senior engineer would let slide. When unsure whether something is real, investigate or frame it explicitly as a question rather than a finding.
- **Severity, not volume.** Lead with what blocks merge. A short review that names the one real bug beats a long one that buries it under nits.

## Sources of truth (read, don't re-summarize)

These define the conventions and gates this repo is checked against, and they are authoritative. Read them at the source so this skill never drifts out of sync — and apply judgment in *interpreting* them for the case at hand, not in deciding whether they apply.

- **[AGENTS.md](../../../AGENTS.md) § Conventions** — effect-based registrations, declaration-merging for events/ctx keys, waterfall `next()` discipline, discriminated-union match-don't-chain, explicit-over-implicit at seams, the empty-`catch` rule, symmetry.
- **AGENTS.md § Defensive patterns (hard-won)** — each bullet is a bug class that bit us. Reviewing anything touching process lifecycle, async/await, disposal, or adapter error paths? Re-read this first — then look for the *adjacent* mistake it doesn't name.
- **AGENTS.md § Type Safety and Documentation** — the doc-sync rule (code change ⇒ update README + JSDoc in the SAME commit) and the no-hard-wrap markdown convention.
- **[packages/AGENTS.md](../../../packages/AGENTS.md)** — per-package conventions (file layout, the HMR-safety test requirement).
- **[ADR index](../../../docs/adr/README.md)** — the *why* behind the architecture. Especially [0007 quality gates](../../../docs/adr/0007-quality-gates.md) (what a PR must pass) and [0009 capability seams](../../../docs/adr/0009-capability-seams.md) (the three-package split). If a change seems to fight an ADR, that's a discussion, not a silent override — and not an automatic veto either: an ADR can be wrong for this case, so reason about it.

## Hard blockers (documented requirements — missing one blocks merge)

These come straight from the source docs above. They are not discretionary; absence is a blocking gap.

1. **Docs in sync.** If the PR changes a config key, default, error code, wire field, or event name, it must update the package README + module/JSDoc in the same diff. The `doc-sync` gate (check #3) does not catch prose drift in config keys, defaults, error codes, or wire fields — that is on the reviewer, but it is still required, not optional.
2. **HMR-safety test.** Any new registry/registration needs a test that disposes the contributing fiber and asserts cleanup (packages/AGENTS.md). Its absence blocks merge.
3. **Quality gates pass.** typecheck, lint, test, test:coverage (100% per-file on `packages/*/src`), knip, build, publint, constraints, `doc-sync` (doc-typecheck + verify-event-taxonomy + verify-md-wrap), module-graph freshness (ADR 0007). Don't re-review what a gate already enforces — trust the gate and spend attention on what it can't check. Note that the `doc-sync` gate only covers compilable `ts` blocks, the event-taxonomy table, and markdown wrapping; prose drift (check #1) is *additional* manual review on top of it, not covered by it.

## Reviewer-only checks (gates can't catch these — judgment required)

Where your independent reasoning earns its keep. Start here, then keep going across the broader aspects above.

- **e2e verifies the world, not the agent's self-report.** For real-API tests, confirm the assertion re-runs the command/checks the file externally — a keyword probe lets a cheating agent pass (see AGENTS.md e2e bullet).
- **Seam discipline.** New swappable capability? Check it's split per ADR 0009 (interface / impl / consumer), and that the consumer injects the interface key, never an implementation type.
- **Test quality.** A test that passes but asserts the wrong thing is worse than none. Check that new tests would actually fail if the behavior regressed, and that they exercise the contract (events fired, disposal reached) rather than restating the implementation.
- **Intent and contracts.** Does the change do what the PR says, and honor the documented contract on *both* sides of every seam it touches (see AGENTS.md "Honor cross-seam contracts on BOTH sides")?

## How to respond

Technical, specific, non-performative — no "great catch", no "you're absolutely right". State the issue, where it is, and why it matters; cite the AGENTS.md bullet or ADR when one applies, but don't manufacture a citation for a finding that stands on its own reasoning. Separate blocking issues from suggestions so the author knows what gates merge. When replying to inline threads on GitHub, reply in the thread (`gh api repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`), not as a top-level comment. If a suggestion would fight an ADR or an established convention, say so and link it rather than relitigating in the thread.

If you are the author *receiving* this review, evaluate each point on its technical merits before acting — verify against the codebase, push back with reasoning where the reviewer lacks context or is wrong, and fix what's correct without performative agreement. A review is a set of claims to evaluate, not orders to follow.
