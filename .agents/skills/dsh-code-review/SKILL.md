---
name: dsh-code-review
description: Use when reviewing a pull request in the deepseek-harness repo — orients the reviewer to this codebase's standards (AGENTS.md conventions, defensive patterns, ADRs, quality gates) and the review-specific checks that code alone can't show
---

# Reviewing a DeepSeek-Harness PR

**This skill is guidance, not authority.** It is a where-to-look map that lowers your startup cost on an unfamiliar PR — it is not a checklist that defines a complete review, and clearing every item here does not mean the PR is good. You are the reviewer. Reason independently from the code in front of you, think broadly across every dimension a change can fail on, and trust your own judgment over this document when they disagree. The items below are the failure modes this repo has already paid for; a real review also catches the ones nobody has written down yet.

## How to think about a review

- **Reason from the code, not from this list.** Read the diff and enough surrounding context to understand what the change actually does, then ask what could go wrong — independently of whether this skill names it. The named patterns are a floor, not a ceiling.
- **Think broadly, across many aspects.** A change can be wrong in correctness, concurrency/lifecycle, error handling, security, performance, API/contract design, type safety, test quality, docs sync, naming, readability, or backward compatibility. Also challenge the *approach itself*: is this the right design, are its assumptions sound, where does it fail under real-world conditions? Don't tunnel on the first defect you spot or the few categories listed under "Where to look first" — sweep all of them.
- **Verify before you flag.** Check a suspected issue against the actual codebase (grep the symbol, read the caller, confirm the path is reachable) before raising it. An unverified claim wastes the author's time and erodes trust in the review.
- **Calibrate confidence; suppress noise.** Distinguish a blocking bug from a nitpick and say which is which. Don't raise things a gate already enforces (typecheck, lint, formatting, type errors, broken tests), pre-existing issues on lines the PR didn't touch, or pedantic style a senior engineer would let slide. When unsure whether something is real, investigate or frame it explicitly as a question rather than a finding.
- **Severity, not volume.** Lead with what blocks merge. A short review that names the one real bug beats a long one that buries it under nits.

## Sources of truth (read, don't re-summarize)

These define many of the conventions this repo is checked against. Read them at the source so this skill never drifts out of sync — but treat them as inputs to your judgment, not a substitute for it.

- **[AGENTS.md](../../../AGENTS.md) § Conventions** — effect-based registrations, declaration-merging for events/ctx keys, waterfall `next()` discipline, discriminated-union match-don't-chain, explicit-over-implicit at seams, the empty-`catch` rule, symmetry.
- **AGENTS.md § Defensive patterns (hard-won)** — each bullet is a bug class that bit us. Reviewing anything touching process lifecycle, async/await, disposal, or adapter error paths? Re-read this first — then look for the *adjacent* mistake it doesn't name.
- **AGENTS.md § Type Safety and Documentation** — the doc-sync rule (code change ⇒ update README + JSDoc in the SAME commit) and the no-hard-wrap markdown convention.
- **[packages/AGENTS.md](../../../packages/AGENTS.md)** — per-package conventions (file layout, the HMR-safety test requirement).
- **[ADR index](../../../docs/adr/README.md)** — the *why* behind the architecture. Especially [0007 quality gates](../../../docs/adr/0007-quality-gates.md) (what a PR must pass) and [0009 capability seams](../../../docs/adr/0009-capability-seams.md) (the three-package split). If a change seems to fight an ADR, that's a discussion, not a silent override — and not an automatic veto either: an ADR can be wrong for this case, so reason about it.

## Where to look first (review-specific, not in the docs)

A starting set of checks the docs don't spell out — not the whole job. After these, keep going on the broader aspects above.

1. **Docs in sync?** If the PR changes a config key, default, error code, wire field, or event name, did it update the package README + module/JSDoc in the same diff? Stale docs are the most common miss — `pnpm run doc-sync` only gates compilable `ts` blocks and the event-taxonomy table, so prose drift (config keys, defaults, error codes, wire fields) has no gate and is on the reviewer to catch.
2. **HMR-safety test present?** Any new registry/registration needs a test that disposes the contributing fiber and asserts cleanup. Its absence is a blocking gap.
3. **Gates green — and trusted?** typecheck, lint, test, test:coverage (100% per-file on `packages/*/src`), knip, build, publint, constraints. Don't re-review what a gate already enforces; spend your attention on what gates can't check — intent, contracts, design, doc sync, test *quality* (a test that passes but asserts the wrong thing is worse than none).
4. **e2e verifies the world, not the agent's self-report.** For real-API tests, confirm the assertion re-runs the command/checks the file externally — a keyword probe lets a cheating agent pass (see AGENTS.md e2e bullet).
5. **Seam discipline.** New swappable capability? Check it's split per ADR 0009 (interface / impl / consumer), and that the consumer injects the interface key, never an implementation type.

## How to respond

Technical, specific, non-performative — no "great catch", no "you're absolutely right". State the issue, where it is, and why it matters; cite the AGENTS.md bullet or ADR when one applies, but don't manufacture a citation for a finding that stands on its own reasoning. Separate blocking issues from suggestions so the author knows what gates merge. When replying to inline threads on GitHub, reply in the thread (`gh api repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`), not as a top-level comment. If a suggestion would fight an ADR or an established convention, say so and link it rather than relitigating in the thread.

If you are the author *receiving* this review, evaluate each point on its technical merits before acting — verify against the codebase, push back with reasoning where the reviewer lacks context or is wrong, and fix what's correct without performative agreement. A review is a set of claims to evaluate, not orders to follow.
