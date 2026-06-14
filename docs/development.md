# Development guide

This guide covers the local setup needed to work on DeepSeek Harness and understand the local hooks, daily checks, and CI gates.

## Prerequisites

- Node.js 24 or newer. The repo declares `node >=24`; CI runs the matrix on Node 24 and 26.
- Corepack-enabled Yarn. The repo pins `yarn@4.14.1` in `package.json`; run `corepack enable` if `yarn --version` does not resolve through Corepack.
- Git.
- Optional: a DeepSeek API key for the coding-agent demo and real-API e2e tests.

## First-time setup

Install dependencies from the repo root:

```sh
yarn install
```

Yarn uses the `node-modules` linker in this repo. The install also runs the root `postinstall` script, which installs lefthook from the repo dev dependency.

If hooks are missing because dependencies were restored from cache or `postinstall` was skipped, install them manually:

```sh
yarn lefthook install
```

Run typecheck once after a fresh clone:

```sh
yarn typecheck
```

That first typecheck builds declaration output used by type-aware linting for vendored packages. Without it, `yarn lint` can report unresolved-type `no-unsafe-*` errors even when source code is fine.

If you are preparing to push from a fresh clone or worktree, also build once:

```sh
yarn build
```

`yarn hygiene` includes `publint`, which validates package entrypoints against the built `lib/*.js` files. A fresh worktree has no bundled JS until `yarn build` runs.

## Environment variables

The real DeepSeek adapter and coding-agent demo read credentials from the environment or from a gitignored `.env` at the repo root:

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` is optional and defaults to the public API. Never commit real credentials. The real-API e2e suites self-skip when `DEEPSEEK_API_KEY` is not set.

## Git hooks

lefthook is configured in `lefthook.yml` as an early local checkpoint before review:

- `pre-commit` runs staged-file ESLint fixes, `yarn typecheck`, and the vendor manifest guard.
- `pre-push` runs `yarn test`, `yarn hygiene`, and `yarn doc-sync`.

The vendor manifest guard checks that changes under `vendor/*/src` are staged with the matching `vendor/README.md` manifest update. See `vendor/README.md` before editing vendored code.

These hooks do not exactly mirror CI. Notably, `pre-push` runs unit tests without coverage, while CI runs `yarn test:coverage`; CI also runs an echo-agent smoke test and exercises the matrix on Node 24 and 26.

## CI gates

The GitHub workflow runs these gates on each pull request:

- `yarn install --immutable`
- `yarn constraints`
- `yarn typecheck`
- `yarn lint`
- `yarn doc-sync`
- `yarn test:coverage`
- `yarn build`
- `yarn knip && yarn publint`
- an echo-agent smoke test that checks the demo's tool call, tool result, and JSONL output

`yarn hygiene` is the local shorthand for `yarn knip && yarn publint && yarn constraints`; CI splits `yarn constraints` into its own earlier step, then runs `yarn knip && yarn publint` after `yarn build`.

## Daily commands

Use these from the repo root:

```sh
yarn test           # unit tests
yarn test:coverage  # unit tests with per-file coverage gates
yarn test:e2e       # real-API tests; self-skips without DEEPSEEK_API_KEY
yarn typecheck      # build declarations, then typecheck source, tests, and examples
yarn lint           # eslint .
yarn lint:fix       # eslint . --fix
yarn doc-typecheck  # compile checked TypeScript snippets in Markdown docs
yarn verify-event-taxonomy  # compare docs/architecture.md event names with source
yarn doc-sync       # doc-typecheck plus event taxonomy verification
yarn build          # build declarations and JS bundles
yarn hygiene        # knip, publint, and yarn constraints
```

When changing package public behavior, update the relevant README or JSDoc in the same change. `yarn doc-sync` catches checked TypeScript snippets and event-taxonomy drift, but broader prose/API sync still needs review.

## Demos

The echo demo does not need API credentials:

```sh
yarn demo:echo
```

The coding-agent demo uses the real DeepSeek adapter and needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
yarn demo:coding
```

## Architecture context

Read `docs/architecture.md` before changing anything under `packages/`. The codebase is built around Cordis plugins, event-sourced sessions, typed service seams, and explicit extension points.
