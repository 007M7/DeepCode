# Agent Note: Oxlint as the repository linter

Status: implemented

English | [中文](2026-07-29-oxlint-linter.zh.md)

## Problem

The repository needs type-aware TypeScript correctness rules, consistent formatting, and file-local duplicate-logic checks across its owned source. ESLint supplied those checks through a JavaScript parser, a project service, and multiple plugins, but a clean lint run spent about one minute on the local migration baseline and required an 8 GiB Node heap, CI result caches, and separately tuned ESLint concurrency.

A faster runner cannot justify losing rules. The migration must preserve the strict type-checked preset, repository overrides, inline suppressions, @stylistic fixes, SonarJS checks, host/client TypeScript separation, and the vendor exclusion.

## Decision

The root [`.oxlintrc.json`](../../../../.oxlintrc.json) is the lint configuration, and `oxlint` is the only lint command used by package scripts, the gate scheduler, CI, and lefthook. The direct `eslint` and `typescript-eslint` development dependencies and `eslint.config.mjs` are absent.

`options.typeAware` enables `oxlint-tsgolint`. The configuration explicitly carries the migrated strict-type-checked rules and repository overrides instead of enabling broad Oxlint categories whose contents may change. `typescript/no-unnecessary-condition` remains enabled from Oxlint's nursery set because it was an enforced repository rule before migration. Oxlint discovers each file's TypeScript project; the existing package projects and separate host/client aggregates remain the source of type context.

Oxlint's JavaScript-plugin compatibility layer runs `@stylistic/eslint-plugin` and `eslint-plugin-sonarjs` so the existing formatting and file-local duplicate-logic rules remain enforced. These packages retain their ESLint peer dependency transitively, but the repository neither configures nor invokes the ESLint runner. Owned-source suppressions use `oxlint-*` directives and the `typescript/*` namespace; vendored sources keep their upstream directives because Oxlint excludes `vendor/**`.

CI does not restore or save a lint-result cache. `DSH_OXLINT_THREADS` optionally bounds Oxlint's native worker count in the gate scheduler for shared or benchmark runners; ordinary local runs use Oxlint's default. Pre-commit applies safe Oxlint fixes to staged JavaScript and TypeScript files and re-stages them through lefthook.

## Verification

The migrated configuration reports the same clean owned-source baseline after resolving two analyzer differences: one redundant test assertion was removed, while one structural cast required by `tsc` carries a narrow Oxlint suppression. The repository lint command exercises type-aware rules and both JavaScript compatibility plugins. Focused gate-scheduler execution covers the explicit thread-bound path, while typecheck confirms that migration-driven source edits preserve the TypeScript programs.

## Alternatives considered

**Run Oxlint before a reduced ESLint fallback.** This is the recommended incremental path when required rules are unsupported, but every enforced repository rule is available through Oxlint's native rules, nursery rule, or JavaScript-plugin compatibility layer. Keeping both runners would preserve the slower program setup and two configurations without adding a check.

**Drop @stylistic or SonarJS rules that are not native.** This would remove dependencies but weaken the mechanical quality contract. The compatibility layer preserves those rules until native replacements can be evaluated as a separate decision.

**Replace @stylistic with Oxfmt during the migration.** A formatter migration would change output beyond the lint-engine boundary and create a repository-wide formatting diff. Keeping the established rules makes this change reviewable and leaves formatter selection independent.

## Consequences

Local migration measurements reduced a clean type-aware lint run from about 61 seconds to about 8 seconds without a result cache. The exact ratio is host-dependent and is not a performance guarantee.

Type-aware diagnostics now come from the TypeScript Go analyzer bundled through `oxlint-tsgolint`, so edge-case inference can differ from typescript-eslint even when `tsc` accepts the same program. Lint and typecheck remain separate required evidence.

The JavaScript-plugin compatibility API is an additional boundary to maintain, and its peer graph still includes ESLint packages. The executable lint path, configuration ownership, cache policy, worker control, and inline directives are nevertheless Oxlint-only.
