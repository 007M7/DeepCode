# Development guide

This guide covers the local setup needed to work on DeepSeek Harness and understand the local hooks, daily checks, and CI gates.

## Prerequisites

- Node.js 24 or newer. The repo declares `node >=24`; CI runs the matrix on Node 24 and 26.
- Corepack-enabled pnpm. The repo pins `pnpm@11.7.0` in `package.json`; run `corepack enable` if `pnpm --version` does not resolve through Corepack.
- Git.
- Optional: a DeepSeek API key for the coding-agent demo and real-API e2e tests.

## First-time setup

Install dependencies from the repo root:

```sh
pnpm install
```

The install also runs the root `postinstall` script, which installs lefthook from the repo dev dependency through `scripts/install-lefthook.mjs`; the wrapper uses lefthook's reviewed `--force` mode so linked worktrees with an existing `core.hooksPath` do not fail normal `pnpm run …` commands.

If hooks are missing because dependencies were restored from cache or `postinstall` was skipped, install them manually:

```sh
pnpm exec lefthook install --force
```

Run typecheck once after a fresh clone:

```sh
pnpm run typecheck
```

That first typecheck builds declaration output used by type-aware linting for vendored packages. Without it, `pnpm run lint` can report unresolved-type `no-unsafe-*` errors even when source code is fine.

If you are preparing to push from a fresh clone or worktree, also build once:

```sh
pnpm run build
```

`pnpm run hygiene` includes `publint`, which validates package entrypoints against the built `lib/*.js` files. A fresh worktree has no bundled JS until `pnpm run build` runs.

## Environment variables

The real DeepSeek adapter and coding-agent demo read credentials from the environment or from a gitignored `.env` at the repo root:

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` is optional and defaults to the public API. Never commit real credentials. The real-API e2e suites self-skip when `DEEPSEEK_API_KEY` is not set.

## Git hooks

lefthook is configured in `lefthook.yml` as an early local checkpoint before review:

- `pre-commit` runs staged-file ESLint fixes, `pnpm run typecheck`, and the vendor manifest guard.
- `pre-push` runs `pnpm run test`, `pnpm run test:snapshot`, `pnpm run hygiene`, `pnpm run doc-sync`, and `pnpm run verify-module-graph`.

The vendor manifest guard checks that changes under `vendor/*/src` are staged with the matching `vendor/README.md` manifest update. See `vendor/README.md` before editing vendored code.

These hooks do not exactly mirror CI. Notably, `pre-push` runs unit tests without coverage, while CI runs `pnpm run test:coverage`; CI also runs an echo-agent smoke test and exercises the matrix on Node 24 and 26.

## CI gates

The GitHub workflow runs these gates on each pull request:

- `pnpm install --frozen-lockfile`
- `pnpm run constraints`
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run doc-sync`
- `pnpm run verify-module-graph`
- `pnpm run test:coverage`
- `pnpm run test:snapshot`
- `pnpm run build`
- `pnpm run knip && pnpm run publint`
- an echo-agent smoke test that checks the demo's tool call, tool result, and JSONL output

`pnpm run hygiene` is the local shorthand for `pnpm run knip && pnpm run publint && pnpm run constraints`; CI splits `pnpm run constraints` into its own earlier step, then runs `pnpm run knip && pnpm run publint` after `pnpm run build`.

## Daily commands

Use these from the repo root:

```sh
pnpm run test           # unit tests
pnpm run test:coverage  # unit tests with per-file coverage gates
pnpm run test:e2e       # real-API tests; self-skips without DEEPSEEK_API_KEY
pnpm run typecheck      # build declarations, then typecheck source, tests, and examples
pnpm run lint           # eslint .
pnpm run lint:fix       # eslint . --fix
pnpm run doc-typecheck  # compile checked TypeScript snippets in Markdown docs
pnpm run verify-event-taxonomy  # compare docs/architecture.md event names with source
pnpm run verify-md-wrap  # fail on hard-wrapped prose paragraphs in docs/README markdown
pnpm run doc-sync       # doc-typecheck, event taxonomy, and markdown wrap verification
pnpm run gen-module-graph     # regenerate docs/module-graph.md from package peerDeps
pnpm run verify-module-graph  # fail if docs/module-graph.md is stale
pnpm run build          # build declarations and JS bundles
pnpm run hygiene        # knip, publint, and workspace constraints
```

When changing package public behavior, update the relevant README or JSDoc in the same change. `pnpm run doc-sync` catches checked TypeScript snippets, event-taxonomy drift, and hard-wrapped markdown prose, but broader prose/API sync still needs review.

## Demos

The echo demo does not need API credentials:

```sh
pnpm run demo:echo
```

The coding-agent demo uses the real DeepSeek adapter and needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
pnpm run demo:coding
```

## TODO markers

Use one of three comment tags to flag known issues in the code, ordered by urgency:

- `FIXME` — an issue that should block a new release. A release should not ship with an open `FIXME` unless reviewers explicitly agree the change can be merged anyway.
- `TODO` — an issue that should be fixed soon, once we have the resources.
- `XXX` — an issue that we may fix someday; lowest priority, no commitment.

Pick the tag that matches the urgency so anyone scanning the code can tell a release blocker from a someday-maybe.

## Architecture context

Read `docs/architecture.md` before changing anything under `packages/`. The codebase is built around Cordis plugins, event-sourced sessions, typed service seams, and explicit extension points.
