# AGENTS.md

This is the monorepo for the DeepSeek Harness group. It currently hosts the code for **DeepSeek Code**, DeepSeek's coding agent product.

## Architecture

This codebase is based on the **Cordis** framework, built microkernel-style: **everything is a plugin**. All necessary Cordis dependencies are copied into this monorepo as vendored source (under `vendor/`) instead of being depended on via npm.

Read [docs/architecture.md](docs/architecture.md) before changing anything under `packages/` — it defines the service map, the event taxonomy, the session/turn/step lifecycle, and the plugin cookbook.

## Design Documents

- [Coding Harness MVP 需求分析](https://trtgsjkv6r.feishu.cn/wiki/ZwK6wfBE9i91V6kzMGYcgRGanxg) — requirement analysis for the initial MVP.
- [微内核Harness实现思路](https://trtgsjkv6r.feishu.cn/wiki/VS9Lw1kQki6mDJk2UHocyuphnsc) — discussion of the microkernel plugin-style architecture ("everything is a plugin").

## Repository Layout

```
vendor/      Vendored Cordis framework source (original npm names, private).
             See vendor/README.md for the manifest, local-modification log,
             and the upstream sync procedure. Do NOT edit casually — every
             divergence must be logged there.
packages/    Harness packages, all named @deepseek-ai/dsh-<name>:
  llm/            abstract LLM service + content-block vocabulary
  llm-deepseek/   DeepSeek API adapter (hand-rolled fetch/SSE)
  llm-pi-ai/      DeepSeek adapter via @earendil-works/pi-ai (design twin)
  session/        event-sourced session log + in-memory store
  system-prompt/  prompt-section + tool-schema assembly registry
  tools/          tool registry + tools/execute waterfall
  agent/          Agent interface, registry, agent/* event vocabulary
  agent-loop/     THE concrete plugin: LoopAgent + the loop driver
  bash/           abstract bash executor seam (ctx.bash) — interface only
  bash-local/     local-subprocess BashExecutor implementation
  tool-bash/      model-facing bash/bash_output/bash_kill tool schemas
examples/    Runnable demos (not workspaces). echo-agent = mock model + echo
             tool + stdio UI + JSONL persistence, wired via cordis.yml.
docs/        architecture.md — the design doc. adr/ — decision records (the
             why behind vendoring, event-sourcing, the schema DSL, …).
             rfc/ — proposals for substantial future work.
scripts/     repo maintenance scripts (vendor-manifest guard, publint runner).
             JS bundling is tsdown (root tsdown.config.ts + two per-package
             overrides in vendor/).
```

## Commands

```sh
yarn install        # Yarn 4 workspaces (node-modules linker), node >= 24
yarn test           # vitest run (packages/*/tests/**/*.spec.ts)
yarn test:e2e       # real-API tests (packages|examples/*/tests/**/*.e2e.ts);
                    # self-skips without DEEPSEEK_API_KEY — see Secrets below
yarn typecheck      # tsc -b tsconfig.build.json (declarations only)
yarn build          # typecheck + tsdown JS bundles into each package's lib/
yarn demo           # run examples/echo-agent (needs --expose-internals, the
                    # script passes it; type "echo hi" to see a tool call)
```

## Secrets / .env

Real-API e2e tests (`yarn test:e2e`) read `DEEPSEEK_API_KEY` (and optionally
`DEEPSEEK_BASE_URL`) from the environment, or from a gitignored `.env` at the
repo root loaded via Node's native `process.loadEnvFile()`:

```
DEEPSEEK_API_KEY=sk-…
DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
```

cordis.yml configs reference env vars with the `!!js` tag:
`apiKey: !!js process.env.DEEPSEEK_API_KEY`. Never commit real credentials;
CI has no secrets and e2e suites must self-skip without them.

Dev/test/demo run **unbuilt** via tsx + the `paths` map in the root
`tsconfig.json` (`vitest` resolves through `tsconfig.test.json`). Building is
only needed for publishing/consumption outside the repo — with one exception:
`yarn lint`'s type-aware rules resolve vendor packages through their built
declarations (`tsconfig.typecheck.json` → `vendor/*/lib`), so run
`yarn typecheck` once after a fresh clone (CI does the same) or lint reports
unresolved-type `no-unsafe-*` errors.

## Conventions

- **Package naming**: every npm package in this repo is `@deepseek-ai/dsh-<name>`
  (vendored packages keep their upstream names and are `private: true`).
- **ESM everywhere** (`"type": "module"`); imports between workspace packages
  use package names, never relative paths across package boundaries.
  In-package imports use explicit `.ts` extensions (allowImportingTsExtensions).
- **`cordis` is a peerDependency** (+ devDependency) of every harness package,
  mirroring upstream convention.
- **Registrations are effects**: anything a plugin contributes (adapter, tool,
  section, agent, event listener) goes through `ctx.effect()` / `ctx.on()` so
  disposal and HMR work. If you write a registry, `register()` must return the
  disposer.
- **Typed events via declaration merging**: services declare their events in
  `declare module 'cordis' { interface Events { … } }`, and their ctx key in
  `interface Context`. Extensible unions use the merge-extensible-map pattern
  (see `ContentBlockMap`, `MessageSourceMap`).
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)`
  and MUST call `next()` to delegate; returning without it short-circuits.
  This is the veto mechanism — use deliberately.
- **Switch exhaustiveness**: switches over CLOSED unions (e.g. `StreamChunk`)
  end with `default: assertNever(value, 'context')` (from dsh-llm) so adding a
  variant breaks compilation at every switch that must handle it. Switches
  over MERGE-EXTENSIBLE unions (`SessionEventMap`, `ContentBlockMap`, …) must
  NOT use assertNever — plugin-added variants are valid unknown values; handle
  known cases and fall through with a comment (the lint rule
  `switch-exhaustiveness-check` makes the choice explicit either way).
- **Plugins, not loop changes**: new behavior goes into a plugin on the
  documented extension seams (see the plugin sanity checklist in
  docs/architecture.md). Changing `agent-loop` requires updating that doc.
- **Capability seams are three packages**: when adding a swappable capability
  (an execution backend, a provider integration, …), split it into
  *interface* (abstract service + vocabulary types, e.g. `bash/`),
  *implementation* (a concrete subclass, e.g. `bash-local/`), and
  *consumer* (what the model/plugins see, e.g. `tool-bash/`). Implementations
  and consumers then evolve independently — a sandboxed executor replaces
  `bash-local` without touching tool schemas. The LLM seam follows the same
  shape (`llm/` is interface + consumer surface; adapters are implementations).
  See docs/architecture.md § "Capability seams" for when NOT to split.
- **Explicit > implicit at package seams**: interface/vocabulary types spell
  out every field a consumer must supply — no optional field that the
  implementation silently fills with a hidden `?? default`. Put defaulting in
  the owning implementation as an explicit step (a `resolve(request): Spec`
  method that turns the optional-field request into the required-field spec),
  not smuggled inside `run()`/`start()`. Example: `dsh-bash` splits
  `BashExecRequest` (optional `workdir`/`timeoutMs`, model-facing) from
  `BashExecSpec` (required, what `run`/`start` act on); the tool layer calls
  `ctx.bash.resolve()` between them. The reader of a `BashExecSpec` never has
  to wonder where the working directory came from.
- **An empty `catch` must name what it swallows and why nothing else can hit
  it**: a bare `catch {}` hides bugs. When you deliberately ignore a throw, the
  comment must (a) name the single expected failure, (b) say why ignoring it is
  correct — usually because the useful state was already captured *before* the
  `try` — and (c) make clear nothing else of consequence can reach the catch
  (ideally the `try` wraps a single statement). Example: the error-body
  `response.json()` parse in `dsh-llm-deepseek`'s adapter sets `code` + HTTP
  `status` from the status line before the `try`, so a malformed provider body
  can only cost a richer message, never the real error.
- **Tests**: vitest, colocated under `packages/<name>/tests/*.spec.ts`. Every
  registry needs an HMR-safety test (dispose the contributing fiber, assert
  cleanup). **Excessive tests are welcome** — when in doubt, write the test;
  err on the side of covering edge cases, error paths, event ordering, and
  concurrency races even if they seem unlikely. Review findings get regression
  tests (see `packages/agent-loop/tests/review-fixes.spec.ts`).

## Type Safety and Documentation

This codebase aims to be **very type-safe and well documented** for
maintainability. Code that fails to compile under `strict: true` (with
`noImplicitAny` enabled for all `packages/*` source) is not acceptable. Every
`any` that remains must have a specific justification (a comment explaining why
a narrower type is infeasible).

In the **core** packages (`packages/llm`, `packages/tools`, `packages/agent`,
`packages/agent-loop`, `packages/session`, `packages/system-prompt`), **type
gymnastics are acceptable when they improve the DX of plugin authors** for
common plugin types. The `defineTool` typed schema DSL in `dsh-tools` is the
canonical example: the `SchemaSpec` to `InferArgs<S>` type-level mapping gives
tool authors zero-cast typed `execute` args, and the cost of the conditional
types stays inside the core package.

Verbose documentation is fine **as long as docs and code stay strictly in
sync**. Out-of-sync docs are worse than no docs. **When you change code, update
its docs in the SAME change** — grep the package README and the module/JSDoc
comments for the old behavior (config keys, defaults, error codes, wire field
names, event names) and fix every hit. CI has no doc-sync gate, so this is on
the author. Every module has a module-level doc comment explaining its role.
Every exported class, interface, type, function, and non-obvious method has a
JSDoc that explains semantics (not just the name) — contracts (what events fire
when), disposal behavior, error behavior, and extension intent. Internal
helpers get docs only where non-obvious. Prefer one-liners when one line
suffices.

**Editing these instructions**: `AGENTS.md` is the real file; `CLAUDE.md` is a
symlink to it (at the repo root and in `packages/`). Always edit `AGENTS.md` —
never write through the `CLAUDE.md` symlink or replace it with a regular file.

## Vendoring Policy

`vendor/` packages are pinned source copies (manifest with upstream commit
SHAs in [vendor/README.md](vendor/README.md)). To update one, follow the sync
procedure there; re-apply (or retire) the logged local modifications and rerun
`yarn test && yarn build`.
