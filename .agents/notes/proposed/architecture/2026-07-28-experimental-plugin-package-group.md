# Agent Note: Experimental plugin package group

Status: proposed

English | [中文](2026-07-28-experimental-plugin-package-group.zh.md)

## Problem

The [package hierarchy](../../../../packages/README.md) groups plugins by product role, but it cannot distinguish supported plugins from prototypes whose contracts and continued existence remain unsettled. After the first tagged release, contributors still need an obvious place for useful experiments that carry no stability, compatibility, migration, or support warranty.

## Proposal

Add `packages/experimental/<pkg>/` as the required home for Cordis plugin packages whose whole public contract is experimental. Package names remain `@deepseek-ai/dsh-<pkg>`; promotion moves the package into its product-role group without renaming it.

The group is also the team's in-repository place to share prototypes: members can discover, run, review, and extend one another's work against the real plugin graph without implying product support.

Experimental packages carry no stability, compatibility, migration, or support promise: they may change APIs, configuration, or data, or disappear, without deprecation or migration. This status does not relax engineering standards; these packages retain the repository's type, test, security, documentation, lifecycle, and snapshot requirements. Non-experimental packages must not take runtime dependencies on them. Examples may use them; any other runtime dependent is itself experimental and belongs under `packages/experimental/`. Tests may use them as development dependencies.

Examples include the pending `@deepseek-ai/dsh-tui-session-changes` `/diff` viewer and the `/btw` plugin; if accepted, they land in this group. A release never promotes a package implicitly. Promotion requires explicit review of the public contract, limitations, test evidence, and a named owner accepting stable-package obligations.

## Alternatives considered

**Keep experiments in product-role groups with README labels.** Labels are easy to miss and cannot enforce dependency boundaries.

**Treat every package as experimental until the first tagged release.** This provides no durable incubation boundary.

**Develop experiments elsewhere.** This loses the real plugin graph, examples, snapshots, and lifecycle checks needed to evaluate them.

## Acceptance criteria

- `packages/experimental/` has a concise group README defining the package-level status, all four disclaimed promises, and the promotion rule.
- Constraints require every experimental plugin package and every non-example runtime dependent of one to live there.
- Package and user documentation label experimental plugins and avoid stability, compatibility, migration, or support promises.

## Risks

The group can become a junk drawer or let “experimental” excuse weak engineering. The repository's [current-owner/current-need rule](../../../../packages/AGENTS.md) and unchanged engineering gates limit that risk. Promotion causes path churn, but the npm name remains stable.
