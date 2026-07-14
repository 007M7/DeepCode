# RFC: A gated Known-Limitations section in every package README

Status: implemented

## Problem

The [documentation standard](../../../AGENTS.md) assigns limitations to the package-README tier ("the per-package contract: config, semantics, limitations, extension points"). Without a required shared shape, variant headings and omissions make "this package has no known limitations" indistinguishable from "nobody wrote them down", and no single grep can enumerate the repo's known gaps.

## Decision

Every package manifest under `packages/<group>/<pkg>/package.json` has a sibling README carrying a canonical `## Known Limitations and Deferred Work` section: a condensed bullet list of consumer-visible gaps (unimplemented features, platform caveats, deliberate MVP cuts) and consciously postponed work (TODO markers, RFC deferrals still open). A `doc-sync` gate, `verify-package-readme-limitations` ([scripts/verify-package-readme-limitations.ts](../../../../scripts/verify-package-readme-limitations.ts)), derives the package set from those manifests, rejects a missing README, and enforces the shape per README: exactly one limitations-like heading, byte-equal to the canonical h2, with at least one top-level bullet. Near-miss headings at any level ("Limitations", "Deferred", "What is NOT here", "Non-goals", …) fail the gate, so variant sections cannot creep back beside — or instead of — the canonical one.

A package with genuinely nothing to declare is whitelisted (`NO_LIMITATIONS` in the script) and must NOT carry the section. The inverted check keeps the whitelist honest in both directions: an empty or boilerplate section cannot satisfy the gate, and giving a whitelisted package real limitations forces the whitelist edit in the same change. Whitelist entries are validated against the scanned package set, so a package rename or removal fails loud instead of silently un-gating a README.

The gate checks presence, shape, and the whitelist; the bullets' truthfulness and specificity are governed by review under the documentation standard, like the rest of the README tier. The standing rule lives in [packages/AGENTS.md](../../../../packages/AGENTS.md).

## Alternatives considered

- **Free-form headings, gate only that "something limitations-like" exists** — preserves variant headings, stays un-greppable, and needs the same near-miss heuristics anyway without buying uniformity.
- **Require the section in ALL READMEs, allowing an empty body or "None."** — boilerplate "None" rots silently as a package gains real limitations; the whitelist inversion turns "nothing declared" into an explicit, lintable claim that review can challenge.
- **A word-count ceiling on the section** — limitation lists are legitimately variable in length; package READMEs are deliberately unbudgeted (per the [budget policy](../../../AGENTS.md)) and review governs their prose.

## Consequences

- A new package cannot ship without either declaring its gaps or explicitly claiming it has none; a missing, drifted, or empty section fails `doc-sync` locally (pre-push) and in CI (`package-readme-limitations` in the run-gates doc-sync leaf set).
- Every package README answers the limitations question through the canonical heading or an explicit no-limitations allowlist entry.
- One more fast tsx script in the `doc-sync` chain; no new dependency (plain `node:fs` glob + line scan).
- The canonical heading is enforced verbatim, so renaming it later is a mechanical one-script-plus-all-READMEs change guarded by the same gate.
