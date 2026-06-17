# AGENTS.md — Docs

Conventions for authoring everything under `docs/` (architecture, RFCs, cookbook, ADRs-now-RFCs). The repo-wide Markdown rules in the root [AGENTS.md](../AGENTS.md) § "Type Safety and Documentation" still apply (one physical line per paragraph, fenced `ts` blocks must compile); the points below are docs-specific.

## Cross-reference with machine-checkable links, never free prose

When one doc refers to another doc, an RFC, a package README, or any file in the repo, link it with a **relative Markdown link** to the actual path — `[capability seams](rfc/implemented/2026-06-13-capability-seams.md)`, `[architecture.md](architecture.md)`. Do NOT refer to it by bare prose or by a number ("see ADR 0009", "per RFC 005"): a number is not checkable, goes stale the moment a file is renamed, and forces the reader to go hunting. A relative link is verified mechanically — `pnpm run verify-md-links` (part of `doc-sync`, see [the cross-link lint RFC](rfc/implemented/2026-06-18-markdown-cross-link-lint.md)) fails CI and the pre-push hook if any relative target does not exist, so a rename that orphans a link is caught before review rather than rotting silently.

This is why the RFC tree carries no stable numbers: files are named `yyyy-mm-dd-topic-title.md` and referred to by link, so they survive moves between `proposed/`/`implemented/`/`rejected/` without a dangling reference. When you move or rename a doc, the gate tells you every inbound link you still need to fix.

The gate checks file *existence*, not `#anchor` validity — a link to a real file with a wrong heading fragment still passes. Prefer linking the file (and a heading when it helps the reader), but don't rely on the gate to catch a stale anchor.

## RFCs

Design decisions and proposals live in [rfc/](rfc/) — one kind of doc, grouped by lifecycle into `proposed/`/`implemented/`/`rejected/`. See [rfc/README.md](rfc/README.md) for the naming scheme and when to write one.
