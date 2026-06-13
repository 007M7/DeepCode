---
name: dsh-code-review
description: Use when reviewing a pull request in the deepseek-harness repo — orients the reviewer to this codebase's standards (AGENTS.md conventions, defensive patterns, ADRs, quality gates) and the review-specific checks that code alone can't show
---

# Reviewing a DeepSeek-Harness PR

This is a where-to-look map, not a rules list. The rules live in the docs below and are the source of truth — read them there so this skill never drifts out of sync with them.

## Sources of truth (read, don't re-summarize)

- **[AGENTS.md](../../../AGENTS.md) § Conventions** — effect-based registrations, declaration-merging for events/ctx keys, waterfall `next()` discipline, discriminated-union match-don't-chain, explicit-over-implicit at seams, the empty-`catch` rule, symmetry. Every PR is checked against these.
- **AGENTS.md § Defensive patterns (hard-won)** — each bullet is a bug class that bit us. Reviewing anything touching process lifecycle, async/await, disposal, or adapter error paths? Re-read this first.
- **AGENTS.md § Type Safety and Documentation** — the doc-sync rule (code change ⇒ update README + JSDoc in the SAME commit) and the no-hard-wrap markdown convention.
- **[packages/AGENTS.md](../../../packages/AGENTS.md)** — per-package conventions (file layout, the HMR-safety test requirement).
- **[ADR index](../../../docs/adr/README.md)** — the *why* behind the architecture. Especially [0007 quality gates](../../../docs/adr/0007-quality-gates.md) (what a PR must pass) and [0009 capability seams](../../../docs/adr/0009-capability-seams.md) (the three-package split). If a change seems to fight an ADR, that's a discussion, not a silent override.

## Where to look first (review-specific, not in the docs)

1. **Docs in sync?** If the PR changes a config key, default, error code, wire field, or event name, did it update the package README + module/JSDoc in the same diff? Stale docs are the most common miss (the doc-sync rule has no gate).
2. **HMR-safety test present?** Any new registry/registration needs a test that disposes the contributing fiber and asserts cleanup. Its absence is a blocking gap.
3. **Gates green?** typecheck, lint, test, test:coverage (100% per-file on `packages/*/src`), knip, build, publint, constraints. Don't re-review what a gate already enforces — trust the gate, spend attention on what gates can't check (intent, contracts, doc sync).
4. **e2e verifies the world, not the agent's self-report.** For real-API tests, confirm the assertion re-runs the command/checks the file externally — a keyword probe lets a cheating agent pass (see AGENTS.md e2e bullet).
5. **Seam discipline.** New swappable capability? Check it's split per ADR 0009 (interface / impl / consumer), and that the consumer injects the interface key, never an implementation type.

## How to respond

Technical, specific, non-performative — no "great catch", no "you're absolutely right". State the issue and where; cite the AGENTS.md bullet or ADR it relates to. When replying to inline threads on GitHub, reply in the thread (`gh api repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`), not as a top-level comment. If a suggestion would fight an ADR or an established convention, say so and link it rather than relitigating in the thread.
