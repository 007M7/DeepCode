# Agent Note: Semantic pull request label taxonomy

Status: implemented

English | [中文](2026-07-25-semantic-pr-label-taxonomy.zh.md)

## Problem

Pull request labels answer two independent questions: what kind of change the work makes and which durable repository domains it materially affects. Mixing those dimensions or keeping synonymous labels makes queries ambiguous, while a closed area inventory forces new domains into inaccurate categories.

Issues already have a native Type and a separate source taxonomy. Reusing pull request kind or source labels across both object types duplicates metadata and weakens the meaning of each label family.

## Decision

Every open or merged pull request carries exactly one canonical `kind/*` label and at least one materially affected `area/*` label. Closed pull requests that were never merged retain migrated historical assignments but do not receive invented missing classification. Operational labels may coexist without satisfying either dimension.

### Kinds

The kind set is closed and mutually exclusive:

| Kind | Meaning |
|---|---|
| `kind/feature` | Adds or intentionally changes behavior. |
| `kind/bug-fix` | Corrects incorrect behavior. |
| `kind/doc` | Makes documentation the dominant intent. |
| `kind/testing` | Changes tests or testing infrastructure without changing product behavior. |
| `kind/cleanup` | Preserves behavior while maintaining or simplifying implementation or repository process. |
| `kind/dependency` | Updates dependencies without another dominant intent. |

The kind records the dominant intent. Accompanying tests, documentation, cleanup, or dependency movement do not override a feature or bug fix.

### Areas

Areas name durable semantic domains rather than temporary initiatives, ownership, or every path touched incidentally. A pull request carries multiple areas when it changes distinct contracts, but it does not combine an umbrella and a narrower label for the same contract. GitHub's live `area/*` names and descriptions own the current inventory.

The area set is intentionally extensible. When no existing description honestly covers a durable and reusable repository domain, an agent is empowered to create a concise `area/<lowercase-kebab-case>` label without separate approval. The agent must not create an area for one pull request, an incidental path, a temporary project, a status, or a person or team, and must report the new label after applying it. Reusing an inaccurate area merely to avoid a justified addition is not acceptable.

Kinds are not extended this way. A new kind changes the mutually exclusive classification contract and requires an explicit taxonomy change with corresponding policy enforcement.

### Issues and operational labels

Issues use native Issue Type instead of `kind/*`; their `area/*` labels remain optional. `source/*` labels record Issue provenance and do not apply to pull requests. Priority, GitHub defaults, and workflow triggers remain independent operational metadata.

Label migrations preserve meaning before removing aliases: add the canonical replacement, verify the labelable, then remove the obsolete assignment. A label is deleted only after no pull request or Issue still uses it, and unrelated labels are never replaced as a set.

## Alternatives considered

- **Unprefixed labels.** Rejected because a flat name does not identify whether it classifies intent, domain, source, priority, or automation, and synonymous plain and prefixed labels caused ambiguous queries.
- **A fixed area allowlist in repository policy.** Rejected because durable repository domains evolve. The `area/*` namespace remains mechanically recognizable while live descriptions carry the extensible inventory.
- **Kinds on Issues.** Rejected because native Issue Type already owns that classification; duplicating it as a label creates drift.
- **Automatic areas from paths.** Rejected because areas describe semantic impact across package boundaries, while changed paths include incidental tests, documentation, and support files.
- **Exactly one area per pull request.** Rejected because coherent changes can materially affect several independent contracts.

## Consequences

Reviewers and automation can query intent, semantic scope, provenance, priority, and operational triggers independently. Maintainers must read the change and live label descriptions rather than infer classification from title prefixes or paths, and taxonomy migrations carry an explicit historical backfill and verification cost.
