# Agent Note: Web favicon follows the color scheme

Status: implemented

English | [中文](2026-08-10-web-favicon-dark-mode.zh.md)

## Problem

`apps/web/public/favicon.svg` paints the DeepSeek mark solid black (`fill="#000"`), and `index.html` declares only that single SVG icon. Under an OS or browser dark color scheme the tab strip is dark too, so the black mark is effectively invisible. Safari additionally ignores SVG favicons entirely, so its users get no tab icon in any scheme.

## Decision

The favicon stays one file and adapts through the browser's own color-scheme signal: `favicon.svg` embeds `@media (prefers-color-scheme: dark) { path { fill: #fff } }`, switching the mark to white under a dark scheme while the light scheme keeps black. `index.html` and `manifest.webmanifest` also declare a 32×32 PNG fallback (`favicon-32x32.png`, DeepSeek brand blue `#4D6BFE`) that Safari renders and that stays visible on both light and dark tab strips, extending the [web-install-manifest decision](../feature/2026-08-06-web-install-manifest.md).

The theme signal is the OS/browser scheme, not the GUI's in-app `dsh.theme` toggle: the favicon lives in browser chrome, whose background follows the browser scheme, so `prefers-color-scheme` is the correct semantic and needs no JavaScript. Known browser quirks — Chromium may not repaint the tab icon until reload after a scheme switch, and Safari ignores the SVG variant — are accepted and the PNG fallback covers the Safari case.

## Alternatives considered

- **A second `<link rel="icon" media="(prefers-color-scheme: dark)">` pointing at a separate dark SVG.** Rejected: the same scheme semantics with two files to keep in sync, and no benefit over the in-file media query.
- **A theme-presenter that swaps the icon href on `theme/change`.** Rejected: it would follow the in-app toggle rather than the browser scheme that actually colors the tab strip, and it adds client code and a presenter for a chrome asset.
- **No PNG fallback.** Rejected: Safari never renders SVG favicons, so the fallback is the only way it gets a tab icon at all.

## Consequences

Light scheme still shows the black mark, dark scheme shows white, and Safari shows the blue PNG in both. `apps/web/tests/pwa-manifest.e2e.ts` now pins the PNG link, both manifest icons, and the dark media query inside the shipped SVG. The Chromium repaint quirk remains a browser behavior the app cannot fix.
