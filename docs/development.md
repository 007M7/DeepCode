# Development guide

English | [中文](development.zh.md)

This onboarding guide helps project contributors get started with the local environment, daily workflow, and CI flow; see the Agent Notes for design rationale and technical trade-offs.

## Prerequisites

- Node.js supports 22.19+ and 24+. CI covers 22.19, 24, and 26; see the [Node engine floor Agent Note](../.agents/notes/implemented/process/2026-07-06-node-engine-floor.md).
- Corepack-enabled pnpm. The repo pins `pnpm@11.7.0` in `package.json`; run `corepack enable` if `pnpm --version` does not resolve through Corepack.
- Git.
- Optional: a DeepSeek API key for the TUI/Headless/ACP agent demos and real-API e2e tests.

## First-time setup

Install dependencies from the repo root:

```sh
pnpm install
```

The install also runs the root `postinstall` script, which installs lefthook from the repo dev dependency through `scripts/install-lefthook.mjs`; the wrapper script uses lefthook's reviewed `--force` mode so linked worktrees with an existing `core.hooksPath` do not fail normal `pnpm run …` commands.

If hooks are missing because dependencies were restored from cache or `postinstall` was skipped, install them manually:

```sh
pnpm exec lefthook install --force
```

Run typecheck once after a fresh clone:

```sh
pnpm run typecheck
```

That first typecheck runs the whole-repo `tsc -b` graph: it emits every package/vendor `lib/types` and checks examples, tests, and scripts through the two no-emit aggregates described below.

## TypeScript project layout

The repository's TypeScript configuration has exactly three roles; every tsconfig file plays one of them.

| File | Role | Forms a program? |
|---|---|---|
| `tsconfig.json` | Solution root: `extends` base, `files: []`, references to the two aggregates. The whole-repo `tsc -b tsconfig.json` graph, the tsserver discovery entry, and — through the inherited `paths` — the resolution config for tsx running `examples/` and `scripts/` (their nearest tsconfig is this file). | No |
| `tsconfig.host.json` | Host aggregate: host-side packages (via references), examples, tests, scripts, website. Excludes `packages/client`. | Yes |
| `tsconfig.client.json` | Client aggregate: `packages/client/*` packages and their tests, `apps/web`. | Yes |
| `tsconfig.base.json` | Shared compilerOptions and the source `paths` map. Also the resolution facade the vitest configs point vite-tsconfig-paths at: it has no `include`, so its `paths` apply to every importer. | No |
| `tsconfig.base.client.json` | Browser compiler shape (`jsx`, DOM libs, `types: []`) extended by the client aggregate and every `packages/client/*` package. | No |

Host and client stay two aggregate programs because both sides declaration-merge the cordis `Context` interface under the same keys with different services; one program seeing both merges reports a collision. The collision exists only inside a `ts.Program` — module resolution never triggers it — which is why the solution may reference both aggregates and one paths facade may span both sides. Two disciplines follow:

- `tsconfig.base.json` never gains `include` or `files`: they would leak into every extending package project and narrow the facade's match-all scope.
- A script that builds a repo-wide `ts.Program` seeds `tsconfig.host.json` or `tsconfig.client.json` explicitly — never the root solution, because flattening both aggregates into one program collides the `Context` merges. Program-backed generators and gates (`scripts/ts-project.ts` consumers, doc-typecheck standalone mode) are host-only by decision; the client side gains program-backed tooling only with a concrete need.

Static analysis and tests resolve workspace imports through the base `paths` map to `src` and must pass on a clean tree; gates that consume built `lib/` output declare that dependency explicitly. Decision record: [solution-root note](../.agents/notes/implemented/process/2026-07-22-tsconfig-solution-root-two-aggregates.md); the tsc-first emit pipeline is the [ts-build-config note](../.agents/notes/implemented/process/2026-06-17-ts-build-config.md).

If a relevant local check consumes built package output, build once first:

```sh
pnpm run build
```

`pnpm run hygiene` includes `publint`, which validates package entrypoints against the built `lib/*.js` files, and `verify-node-next-types`, which validates built declarations against a temporary NodeNext consumer. A fresh worktree has no bundled JS or declarations until `pnpm run build` runs; ordinary commits and pushes do not require that build unless their selected checks consume it.

## Environment variables

The real DeepSeek adapter and key-backed agent demos read credentials from the environment or from a gitignored `.env` at the repo root:

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` is optional and defaults to the public API. Never commit real credentials. The real-API e2e suites self-skip when `DEEPSEEK_API_KEY` is not set.

## Git hooks

lefthook is configured in `lefthook.yml` as a fast local checkpoint:

- `pre-commit` runs staged-file ESLint fixes, checks the staged diff for whitespace errors, and runs the vendor manifest guard.
- `pre-push` runs only the incremental repository typecheck (`tsc -b` over the root solution, covering both the host and client aggregates).

The vendor manifest guard checks that changes under `vendor/*/src` are staged with the matching `vendor/README.md` manifest update. See `vendor/README.md` before editing vendored code.

The hooks intentionally do not run tests, snapshots, documentation checks, builds, or hygiene. Contributors run the [checks relevant to the changed behavior](../AGENTS.md#run-relevant-checks-locally) once; CI owns exhaustive coverage, built-artifact smokes, and the Node 22.19, 24, and 26 compatibility matrix.

Contributors can opt into the comprehensive local gate set with `pnpm run check:all`. The command is independent of both Git hooks and is not an agent instruction.

## CI gates

The keyless [CI workflow](../.github/workflows/ci.yml) groups independent gates into broad lanes and runs a smaller compatibility signal across supported Node versions. Artifact consumers wait for one build within their lane. The separate real-API workflow runs `pnpm run test:e2e` with its configured worker bound. See [scripts/run-gates.ts](../scripts/run-gates.ts) and the workflow files for the current gate and job inventory.

## Daily commands

Use these from the repo root:

```sh
pnpm run test           # unit tests
pnpm run test:coverage  # unit tests with per-file coverage gates
pnpm run test:e2e       # real-API tests; self-skips without DEEPSEEK_API_KEY
pnpm run check:all      # comprehensive opt-in gate set; not wired to Git hooks
pnpm run typecheck      # tsc -b over the root solution: emits package/vendor lib/types, checks both aggregates
pnpm run lint           # eslint .
pnpm run lint:fix       # eslint . --fix
pnpm run doc-typecheck  # compile checked TypeScript snippets in Markdown docs
pnpm run gen-cordis-catalog     # regenerate docs/cordis-catalog/events.md + services.md from source
pnpm run verify-cordis-catalog  # fail if either cordis catalog is stale
pnpm run verify-export-jsdoc    # fail if a module-level package export lacks complete JSDoc
pnpm run gen-doc-graphs     # regenerate generated relationship docs from source and curated graph definitions
pnpm run verify-doc-graphs  # fail if generated relationship docs are stale
pnpm run verify-md-wrap  # fail on hard-wrapped prose paragraphs in docs/README markdown
pnpm run verify-mermaid  # fail if a ```mermaid diagram has invalid Mermaid syntax
pnpm run verify-type-equiv  # fail if a ```ts type-equiv doc block drifts from its source type
pnpm run verify-doc-budgets  # fail if a budgeted standing doc exceeds its word ceiling
pnpm run doc-sync       # all Markdown/doc gates, scheduled concurrently; the doc-sync leaf list in scripts/run-gates.ts is the full list
pnpm run gen-module-graph     # regenerate docs/module-graph.md from package peerDeps
pnpm run verify-module-graph  # fail if docs/module-graph.md is stale
pnpm run build          # emit lib/types intermediates, then bundle lib/index.* runtime files
pnpm run verify-node-next-types  # fail if built declarations are not NodeNext-consumable
pnpm run hygiene        # knip, publint, workspace constraints, and NodeNext declaration check
```

When changing package public behavior, update the relevant README or JSDoc in the same change. `pnpm run doc-sync` catches checked TypeScript snippets, generated doc freshness, markdown wrap/link drift, type equivalence, translation pairing, Mermaid syntax, and doc budgets, but broader prose/API sync still needs review.

## Demos

The one-shot Headless coding agent needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
pnpm run demo:headless "summarize this workspace"
```

The full-screen interactive coding agent needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
pnpm run demo:tui
```

The self-referential cordis-agent demo can inspect and modify its live plugin runtime and needs the same credentials:

```sh
pnpm run demo:cordis
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

The [core data structures](core-data-structures/core.md) docs paste source-equivalent declarations together with their original JSDoc so a reader sees the exact shape and source contract. To keep a paste from drifting when source changes, fence it as ` ```ts type-equiv ` (instead of ` ```ts `) and register it in `scripts/type-equiv.manifest.json` with the source file and symbol it mirrors:

```json
{ "doc": "docs/core-data-structures/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv` (part of `doc-sync`) then extracts that symbol's declaration and attached JSDoc from source via the TypeScript parser and asserts the block matches both. For a class whose implementation bodies do not belong in the catalog, use ` ```ts public-api ` and set `"projection": "public-api"`; the checked projection retains the public fields, constructor, accessors, methods, and original class/member JSDoc while omitting bodies and private or protected members. Comparison ignores whitespace and non-JSDoc comments but requires every original JSDoc comment, including member documentation, so readers see the source contract beside the exact shape. The gate also enforces a 1:1 correspondence by document, symbol, and projection, so a block can't go silently unchecked and a stale entry can't linger. `doc-typecheck` skips both fence kinds (they aren't standalone-compilable) and excludes them from its opt-out ratio. When you change a documented declaration or its JSDoc, the gate fails until you update the paste; when you add or remove a block, update the manifest in the same change.

## Architecture context

Read `docs/architecture.md` before changing anything under `packages/`. The codebase is built around Cordis plugins, event-sourced sessions, typed service seams, and explicit extension points.
