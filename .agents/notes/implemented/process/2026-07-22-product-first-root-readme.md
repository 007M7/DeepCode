# Agent Note: Product-first root README

Status: implemented

English | [中文](2026-07-22-product-first-root-readme.zh.md)

## Problem

The root README is the first page for people evaluating DeepSeek Harness, but SDK-first contributor detail competes with the shortest path from product identity to installation and launch. Exhaustive package inventories, architecture diagrams, demos, and duplicated technical explanations also age faster than the interfaces they describe.

## Decision

The root README presents DeepSeek Harness as an installable coding agent first. It names the SDK foundation, keeps the supported one-line installer, and puts the Web UI, TUI, and headless entry points before architecture and contributor material.

The capability overview stays compact: it identifies the familiar built-in coding capabilities, makes plugin extensibility the distinguishing design, and presents Code Mode and the self-referential Cordis tools as explicit opt-ins. Detailed contracts remain at their owning documentation and are linked instead of copied into the root README.

The English and Chinese READMEs share the product, installation, capability, development, and license structure. Their community sections intentionally follow the primary channel for each language audience: Twitter in English and the WeChat community QR code in Chinese. The QR code is the only retained README media because it is a functional entry point rather than product decoration.

## Alternatives considered

**Keep an SDK-first contributor README.** This makes the repository architecture visible immediately, but it delays the answer to what the product is and how to run it. Contributor orientation remains available through the development and architecture links.

**Adopt a full marketing page with badges, screenshots, an architecture diagram, a package catalog, and tutorials.** This provides more material on the landing page, but duplicates fast-moving facts and creates media maintenance work before the product surface is stable.

**Use the same community channel in both languages.** Exact channel symmetry is simpler, but it is less useful when the two language audiences gather in different places. The technical content remains paired while the community destination is audience-specific.

## Consequences

A new reader reaches a runnable interface quickly and can follow stable links for deeper SDK details. The root README stays small enough to update whenever the installer or CLI surface changes. Rich media, package inventories, and long-form tutorials remain outside this entry point until they have a durable owner and maintenance path.
