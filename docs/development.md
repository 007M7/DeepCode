# Development guide

English | [中文](development.zh.md)

The setup tutorial takes a new contributor from prerequisites to a checked checkout. The contributor reference that follows covers repository layout, daily workflow, and CI shape. Design rationale and implementation details belong to the linked Agent Notes and scripts.

## Setup tutorial

### Prerequisites

- Node.js supports 22.19+ and 24+. CI covers 22.19, 24, and 26; see the [Node engine floor Agent Note](../.agents/notes/implemented/process/2026-07-06-node-engine-floor.md).
- Corepack-enabled pnpm. The repo pins `pnpm@11.7.0` in `package.json`; run `corepack enable` if `pnpm --version` does not resolve through Corepack.
- Git 2.26 or newer; hook setup enables Git's worktree-specific configuration extension.
- Optional: a DeepSeek API key for the Web, headless, and ACP automation demos and real-API e2e tests.

### First-time setup

Install dependencies from the repo root:

```sh
pnpm install
```

The install also configures worktree-local lefthook hooks through `scripts/install-lefthook.mjs`. The [worktree-local hooks Agent Note](../.agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.md) owns the safety and migration contract.

If hooks are missing because dependencies were restored from cache or `postinstall` was skipped, install them manually:

```sh
node scripts/install-lefthook.mjs
```

If the wrapper rejects existing Git configuration or reports a stale lock, follow its diagnostic and the linked Agent Note rather than editing worktree metadata speculatively. After moving a checkout, rerun the wrapper to regenerate the owned path.

Run typecheck once after a fresh clone:

```sh
pnpm run typecheck
```

Setup is complete when `pnpm run typecheck` exits successfully.

## Contributor reference

### TypeScript project layout

The repository typecheck runs the whole-repo `tsc -b` graph: it emits every package/vendor `lib/types` and checks examples, tests, and scripts through two no-emit aggregates.

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

Business services declare callable methods on the Host with `@Remote` or `@RemoteContext`; the Host build generates Host-for-Client types and runtime contributions, and the Client's `api-remotes` composition loads those contributions and mounts concrete methods on `ctx.api` or the corresponding scoped Context. See [API Gateway](api-gateway.md) for the generated artifacts on both sides, their assembly relationships, the SRC development fallback, and the Web build order.

If a relevant local check consumes built package output, build once first:

```sh
pnpm run build
```

`pnpm run hygiene` includes `publint`, which validates package entrypoints against the built `lib/*.js` files, and `verify-node-next-types`, which validates built declarations against a temporary NodeNext consumer. A fresh worktree has no bundled JS or declarations until `pnpm run build` runs; ordinary commits and pushes do not require that build unless their selected checks consume it.

### Environment variables

The real DeepSeek adapter and key-backed agent demos read credentials from the environment or from a gitignored `.env` at the repo root:

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` is optional and defaults to the public API. Never commit real credentials. The real-API e2e suites self-skip when `DEEPSEEK_API_KEY` is not set.

### Git hooks

lefthook is configured in `lefthook.yml` as a fast local checkpoint:

- `pre-commit` applies formatting-only ESLint fixes, validates the staged files with Oxlint and applies its native fixes, regenerates `THIRD_PARTY_NOTICES.md` when a staged file is one of its inputs, checks the staged diff for whitespace errors, and runs the vendor manifest guard.
- `pre-push` runs only the incremental repository typecheck (`tsc -b` over the root solution, covering both the host and client aggregates).

The vendor manifest guard checks that changes under `vendor/*/src` are staged with the matching `vendor/README.md` manifest update. See `vendor/README.md` before editing vendored code.

The hooks intentionally do not run tests, snapshots, documentation checks, builds, or hygiene. Contributors run the [checks relevant to the changed behavior](../AGENTS.md#run-relevant-checks-locally) once; CI owns exhaustive coverage, built-artifact smokes, and the Node 22.19, 24, and 26 compatibility matrix.

Contributors can opt into the comprehensive local gate set with `pnpm run check:all`. The command is independent of both Git hooks and is not an agent instruction.

### CI gates

The keyless [CI workflow](../.github/workflows/ci.yml) groups independent gates into broad lanes and runs a smaller compatibility signal across supported Node versions. Artifact consumers wait for one build within their lane. The separate real-API workflow runs `pnpm run test:e2e` with its configured worker bound. See [scripts/run-gates.ts](../scripts/run-gates.ts) and the workflow files for the current gate and job inventory.

### Daily commands

The root [contributor instructions](../AGENTS.md#commands) summarize common commands, while [`package.json`](../package.json) and [scripts/run-gates.ts](../scripts/run-gates.ts) own the current script and gate inventories. Select the smallest checks that cover the changed surface. Documentation changes use `pnpm run doc-sync`; package-public behavior changes also update the owning README or JSDoc, and built-artifact checks require `pnpm run build` first.

### Demos

The one-shot Headless coding agent needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
pnpm run demo:headless "summarize this workspace"
```

The self-referential cordis demo can inspect and modify its live plugin runtime and needs the same credentials (`web` by default, or `acp`):

```sh
pnpm run demo:cordis
```

The ACP automation server exposes fresh agent sessions over JSON-RPC stdio and also needs `DEEPSEEK_API_KEY`:

```sh
pnpm run demo:acp
```

### TODO markers

Use one of three comment tags to flag known issues in the code, ordered by urgency:

- `FIXME` — an issue that should block a new release. A release should not ship with an open `FIXME` unless reviewers explicitly agree the change can be merged anyway.
- `TODO` — an issue that should be fixed soon, once we have the resources.
- `XXX` — an issue that we may fix someday; lowest priority, no commitment.

Pick the tag that matches the urgency so anyone scanning the code can tell a release blocker from a someday-maybe.

### Documenting types verbatim (`ts type-equiv`)

The [core data structures](core-data-structures/core.md) docs paste source-equivalent declarations together with their original JSDoc so a reader sees the exact shape and source contract. To keep a paste from drifting when source changes, fence it as ` ```ts type-equiv ` (instead of ` ```ts `) and register it in `scripts/type-equiv.manifest.json` with the source file and symbol it mirrors:

```json
{ "doc": "docs/core-data-structures/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv` (part of `doc-sync`) then extracts that symbol's declaration and attached JSDoc from source via the TypeScript parser and asserts the block matches both. For a class whose implementation bodies do not belong in the catalog, use ` ```ts public-api ` and set `"projection": "public-api"`; the checked projection retains the public fields, constructor, accessors, methods, and original class/member JSDoc while omitting bodies and private or protected members. Comparison ignores whitespace and non-JSDoc comments but requires every original JSDoc comment, including member documentation, so readers see the source contract beside the exact shape. The gate enforces a 1:1 correspondence by document, symbol, and projection between primary blocks and manifest entries; a paired `.zh.md` block reuses its unsuffixed sibling's entry only when the whole tracked fence sequence is byte-identical and ordered identically. `doc-typecheck` applies the same derivative rule to compilable fences, while skipping both source-equivalence fence kinds from compilation and its opt-out ratio. When you change a documented declaration or its JSDoc, the gate fails until you update the paste; when you add or remove a primary block, update the manifest in the same change.
