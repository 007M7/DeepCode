# Development guide

English | [中文](development.zh.md)

This onboarding guide helps project contributors get started with the local environment, daily workflow, and CI flow; see the RFCs for design rationale and technical trade-offs.

## Prerequisites

- Node.js supports 22.19+ and 24+. CI covers 22.19, 24, and 26; see the [Node engine floor RFC](rfc/implemented/process/2026-07-06-node-engine-floor.md).
- Corepack-enabled pnpm. The repo pins `pnpm@11.7.0` in `package.json`; run `corepack enable` if `pnpm --version` does not resolve through Corepack.
- Git.
- Optional: a DeepSeek API key for the REPL/ACP agent demos and real-API e2e tests.

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

That first typecheck runs the package/vendor build graph and the root no-emit `tsconfig.json` graph for examples, tests, and scripts. The root graph uses the same source `paths` map but relies on project references so vendored code is checked under its own tsconfig settings.

If you are preparing to push from a fresh clone or worktree, also build once:

```sh
pnpm run build
```

`pnpm run hygiene` includes `publint`, which validates package entrypoints against the built `lib/*.js` files, and `verify-node-next-types`, which validates built declarations against a temporary NodeNext consumer. A fresh worktree has no bundled JS or declarations until `pnpm run build` runs.

## Environment variables

The real DeepSeek adapter and key-backed agent demos read credentials from the environment or from a gitignored `.env` at the repo root:

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` is optional and defaults to the public API. Never commit real credentials. The real-API e2e suites self-skip when `DEEPSEEK_API_KEY` is not set.

## Git hooks

lefthook is configured in `lefthook.yml` as an early local checkpoint before review:

- `pre-commit` runs staged-file ESLint fixes, `pnpm run typecheck`, and the vendor manifest guard.
- `pre-push` runs `pnpm run check:pre-push`, whose scheduler runs unit tests, snapshot tests, build, module-graph freshness, and the member gates of `pnpm run hygiene` and `pnpm run doc-sync` concurrently.

The vendor manifest guard checks that changes under `vendor/*/src` are staged with the matching `vendor/README.md` manifest update. See `vendor/README.md` before editing vendored code.

These hooks do not exactly mirror CI. Notably, `pre-push` runs unit tests without coverage, while CI runs `pnpm run test:coverage`; CI also runs echo-agent and built-bin smoke tests and exercises the compatibility matrix on Node 22.19, 24, and 26.

## CI gates

The keyless [CI workflow](../.github/workflows/ci.yml) groups independent gates into broad lanes and runs a smaller compatibility signal across supported Node versions. Artifact consumers wait for one build within their lane. The separate real-API workflow runs `pnpm run test:e2e` with its configured worker bound. See [scripts/run-gates.ts](../scripts/run-gates.ts) and the workflow files for the current gate and job inventory.

## Daily commands

Use these from the repo root:

```sh
pnpm run test           # unit tests
pnpm run test:coverage  # unit tests with per-file coverage gates
pnpm run test:e2e       # real-API tests; self-skips without DEEPSEEK_API_KEY
pnpm run typecheck      # build package/vendor outputs, then typecheck examples, tests, and scripts
pnpm run lint           # eslint .
pnpm run lint:fix       # eslint . --fix
pnpm run doc-typecheck  # compile checked TypeScript snippets in Markdown docs
pnpm run gen-cordis-catalog     # regenerate docs/cordis-catalog/events.md + services.md from source
pnpm run verify-cordis-catalog  # fail if either cordis catalog is stale
pnpm run verify-export-jsdoc    # fail if a module-level package export lacks complete JSDoc
pnpm run gen-doc-graphs     # regenerate generated relationship docs from source and curated graph definitions
pnpm run verify-doc-graphs  # fail if generated relationship docs are stale
pnpm run gen-rfc-index          # regenerate the docs/rfc/README.md index tables from the RFC tree
pnpm run verify-md-wrap  # fail on hard-wrapped prose paragraphs in docs/README markdown
pnpm run verify-mermaid  # fail if a ```mermaid diagram has invalid Mermaid syntax
pnpm run verify-type-equiv  # fail if a ```ts type-equiv doc block drifts from its source type
pnpm run verify-doc-budgets  # fail if a budgeted standing doc exceeds its word ceiling
pnpm run doc-sync       # all Markdown/doc gates; see the doc-sync script in package.json for the full list
pnpm run gen-module-graph     # regenerate docs/module-graph.md from package peerDeps
pnpm run verify-module-graph  # fail if docs/module-graph.md is stale
pnpm run build          # emit lib/types intermediates, then bundle lib/index.* runtime files
pnpm run verify-node-next-types  # fail if built declarations are not NodeNext-consumable
pnpm run hygiene        # knip, publint, workspace constraints, and NodeNext declaration check
```

When changing package public behavior, update the relevant README or JSDoc in the same change. `pnpm run doc-sync` catches checked TypeScript snippets, generated doc freshness, markdown wrap/link drift, type equivalence, translation pairing, Mermaid syntax, and doc budgets, but broader prose/API sync still needs review.

## Demos

The echo demo does not need API credentials:

```sh
pnpm run demo:echo
```

The REPL agent demo uses the real DeepSeek adapter and needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
pnpm run demo:repl
```

The ACP server agent demo exposes the agent over JSON-RPC stdio and also needs `DEEPSEEK_API_KEY`:

```sh
pnpm run demo:acp
```

## TODO markers

Use one of three comment tags to flag known issues in the code, ordered by urgency:

- `FIXME` — an issue that should block a new release. A release should not ship with an open `FIXME` unless reviewers explicitly agree the change can be merged anyway.
- `TODO` — an issue that should be fixed soon, once we have the resources.
- `XXX` — an issue that we may fix someday; lowest priority, no commitment.

Pick the tag that matches the urgency so anyone scanning the code can tell a release blocker from a someday-maybe.

## Documenting types verbatim (`ts type-equiv`)

The [core data structures](core-data-structures/core.md) docs paste real type definitions so a reader sees the exact shape. To keep a paste from drifting when source changes, fence it as ` ```ts type-equiv ` (instead of ` ```ts `) and register it in `scripts/type-equiv.manifest.json` with the source file and symbol it mirrors:

```json
{ "doc": "docs/core-data-structures/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv` (part of `doc-sync`) then extracts that symbol's declaration from source via the TypeScript parser and asserts the block matches it (whitespace- and comment-insensitive, so a doc block may show a clean definition and the prose can carry the semantics). It also enforces a 1:1 correspondence: every `ts type-equiv` block has exactly one manifest entry and vice-versa, so a block can't go silently unchecked and a stale entry can't linger. `doc-typecheck` skips `ts type-equiv` blocks (they aren't standalone-compilable) and excludes them from its opt-out ratio. When you change a documented type, the gate fails until you update the paste; when you add or remove a block, update the manifest in the same change.

## Architecture context

Read `docs/architecture.md` before changing anything under `packages/`. The codebase is built around Cordis plugins, event-sourced sessions, typed service seams, and explicit extension points.
