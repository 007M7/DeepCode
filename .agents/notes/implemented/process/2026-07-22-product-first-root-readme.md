# Agent Note: Product-first root README

Status: implemented

English | [中文](2026-07-22-product-first-root-readme.zh.md)

## Problem

The root README is the repository's product front door, but a product-only coding-agent description hides the SDK and current runtime breadth, while an SDK-first package inventory delays the shortest path to a working agent. Commands, capability claims, and entry-point descriptions also drift when the README is treated as general marketing instead of a maintained product contract.

## Decision

The root README defines DeepSeek Harness as a plugin-native coding-agent runtime that ships both a composable SDK and the assembled `dsh` agent. It separates mission from shipped facts and leads with the supported one-line installer.

A note before the installer thanks early users, states plainly that the internal preview remains unfinished, has a low overall level of completion, and falls below the experience the team wants to deliver. It invites direct reports of failures, confusion, and friction, assigning those shortcomings to the product rather than the user, while the adjacent pre-release warning keeps the compatibility boundary explicit.

The README names the TUI, Web, headless, ACP, and Python/JSON-RPC entry points with commands or owning links. It summarizes capabilities by coding, orchestration, and operational families, while stating that each composition selects its own plugins. Exhaustive package and service inventories stay in the generated graphs and package-group documentation.

Plugin-native is the organizing principle rather than a slogan: the README ties replaceable services and typed events to composition through `cordis.yml`, and ties model-visible behavior, persistence, replay, queries, telemetry, and UI projections to the authoritative session log. Detailed contracts remain with the architecture, CLI, examples, cookbook, and generated catalogs.

The English and Chinese README sides share the same technical structure. Their community sections point to the primary channel for each language audience. The documentation website keeps its separate user-guide landing page; the repository README is not added to that projection.

## Alternatives considered

**Present only the assembled coding agent.** This gives the shortest product pitch but makes the SDK, alternate front doors, and replaceable runtime seams look incidental even though they are shipped repository surfaces.

**Present the repository as an SDK and package catalog.** This exposes implementation breadth immediately but makes a new reader reconstruct the product from package names. The package map and generated capability graph remain the authoritative inventories.

**Use a long marketing page with screenshots, badges, and duplicated tutorials.** Rich media can demonstrate a stable product journey, but it ages separately from commands and source contracts. The root stays compact and links to runnable examples and owned guides.

**Project the root README as the documentation website home page.** A single landing page avoids two narratives, but the website's user guide and the repository's developer/product front door have different navigation and maintenance needs. They remain separate sources linked to the same architecture and guides.

## Consequences

A new reader can install or choose a runtime surface before learning the package topology, while an SDK reader can see the extension model without a generated catalog being copied into prose. The README must change with any affected command, entry point, pre-release boundary, or high-level capability family, and each claim remains reviewable against source or an owning document.
