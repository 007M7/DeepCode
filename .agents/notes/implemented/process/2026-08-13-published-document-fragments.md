# Agent Note: Validate published document fragments

Status: implemented

English | [中文](2026-08-13-published-document-fragments.zh.md)

## Problem

`verify-md-links` validates fragments with GitHub's Markdown heading ids, while the documentation website renders headings with VitePress. Punctuation-heavy headings and translated headings can therefore pass source validation but produce links to ids absent from the published HTML. A successful VitePress build validates target pages, not fragment ids.

## Decision

`docs:build` and its MPA variant run `verify-doc-site-fragments` after VitePress emits `website/.dist`. The verifier parses every emitted HTML page, resolves each internal fragment link against VitePress clean URLs, and fails when the output is absent or either the target page or requested id is missing. Unit tests cover absent output, clean URLs, `.html` aliases, same-page links, encoded ids, missing ids, missing routes, and external-link exclusion.

Generated config, tool, and persistence catalogs emit explicit GitHub-compatible id aliases before punctuation-heavy headings. Authored translated pages add explicit language-neutral aliases when their localized VitePress heading id differs from the shared fragment used by the bilingual pair. Source Markdown validation remains independent and continues to reject links that do not resolve under repository rendering.

## Alternatives considered

**Use locale-specific fragments.** Bilingual pairs intentionally preserve identical link targets. Locale-specific fragments would make the two sources disagree and would require every link producer to know the target locale's translated heading.

**Rely on VitePress heading ids.** Those ids depend on rendered punctuation and localized heading text. They do not preserve the GitHub ids already used by repository links and generated references.

**Check source Markdown only.** This leaves the published artifact unverified and cannot detect differences between the GitHub and VitePress slug algorithms.

## Consequences

Every production documentation build reads its emitted HTML once, adding a bounded post-build check to the existing site build. Cross-page fragment links now require an id that survives publication. Explicit aliases become part of the published reference and let headings change language or punctuation without invalidating established fragments.
