# ADR 0007: Mechanical quality gates over prose guidelines

Status: accepted (2026-06-11)

## Context

This codebase is developed primarily by coding agents. Agents follow enforced
gates far more reliably than prose conventions, and "a lot of work" is not a
cost argument when agents do the labor. Early evidence: tests that didn't
typecheck shipped (vitest doesn't typecheck) and were only caught by a review.

## Decision

Every AGENTS.md promise gets a command that exits non-zero, wired into git
hooks and CI both calling the same package.json scripts:

- Max-strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, …); tests and examples typecheck in CI via
  `tsconfig.typecheck.json` (vendored packages resolve as built declarations).
- ESLint strict-type-checked + @stylistic (the house style, enforced);
  vendored code excluded.
- Per-file 100% coverage on `packages/*/src` (v8); unreachable defensive
  guards carry `/* v8 ignore */ ` with stated reasons instead of deletion.
- knip (dead code/deps), publint (package correctness), yarn constraints
  (workspace rules: private, cordis peer+dev, uniform version, ESM).
- lefthook pre-commit (lint staged, typecheck, vendor-manifest guard) and
  pre-push (tests, hygiene); CI runs the full matrix on node 24/26 plus a
  demo smoke test driving the echo-agent end to end.

## Consequences

- Conventions survive agent turnover; violations fail fast and locally.
- The gates themselves are code to maintain; config changes are reviewed like
  any change.
- 100%-coverage pressure can produce assertion-free tests — mutation testing
  is the planned counterweight (see RFC 002).
