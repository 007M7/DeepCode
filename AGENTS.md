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
  invariants/     dev-mode event-contract invariants + session-log freeze
  bash/           abstract bash executor seam (ctx.bash) — interface only
  bash-local/     local-subprocess BashExecutor implementation
  tool-bash/      model-facing bash/bash_output/bash_kill tool schemas
examples/    Runnable demos (not workspaces). echo-agent = mock model + echo
             tool + stdio UI + JSONL persistence, wired via cordis.yml.
             coding-agent = the real thing: DeepSeek V4 + bash tools
             (pnpm run demo:coding, needs DEEPSEEK_API_KEY).
docs/        architecture.md — the design doc. module-graph.md — generated
             inter-package dependency graph (Mermaid; `pnpm run gen-module-graph`).
             rfc/ — design decisions and proposals, one kind of doc grouped by
             lifecycle into proposed/ implemented/ rejected/ (the why behind
             vendoring, event-sourcing, the schema DSL, …). See rfc/README.md.
             cookbook/ — step-by-step guides: adding a package, a tool,
             an LLM adapter.
scripts/     repo maintenance scripts (vendor-manifest guard, publint runner).
             JS bundling is tsdown (root tsdown.config.ts + two per-package
             overrides in vendor/).
```

## Commands

```sh
pnpm install        # pnpm workspaces, node >= 24
pnpm run test           # vitest run (packages/*/tests/**/*.spec.ts)
pnpm run test:coverage  # vitest run --coverage (per-file 100% gate on packages/*/src)
pnpm run test:e2e       # real-API tests (packages|examples/*/tests/**/*.e2e.ts);
                    # self-skips without DEEPSEEK_API_KEY — see Secrets below
pnpm run typecheck      # tsc -b tsconfig.build.json (declarations) + tsc -p
                    # tsconfig.typecheck.json (tests/examples typecheck too)
pnpm run lint           # eslint .
pnpm run lint:fix       # eslint . --fix
pnpm run build          # tsc -b tsconfig.build.json && tsdown (JS bundles into lib/)
pnpm run knip           # dead-code / unused-dependency check
pnpm run publint        # package.json publish-correctness check (publishable packages/*)
pnpm run hygiene        # knip + publint + workspace constraints
pnpm run doc-typecheck  # typecheck every ```ts block in README.md, docs/**/*.md,
                    # packages/*/README.md (doc/code drift gate)
pnpm run verify-event-taxonomy  # assert the event-taxonomy table in docs/architecture.md
                    # matches the interface Events declarations in source
pnpm run verify-md-wrap  # assert no hard-wrapped prose paragraphs in README.md,
                    # docs/**/*.md, packages/*/README.md, AGENTS.md (one line per paragraph)
pnpm run doc-sync       # doc-typecheck + verify-event-taxonomy + verify-md-wrap (CI runs this)
pnpm run demo:echo      # run examples/echo-agent (no API key; type "echo hi" to
                    # see a tool call) — the mock skeleton
pnpm run demo:coding    # run examples/coding-agent — the real agent (needs
                    # DEEPSEEK_API_KEY; give it a coding task)
```

## Secrets / .env

Real-API e2e tests (`pnpm run test:e2e`) read `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_BASE_URL`) from the environment, or from a gitignored `.env` at the repo root loaded via Node's native `process.loadEnvFile()`:

```
DEEPSEEK_API_KEY=sk-…
DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
```

cordis.yml configs reference env vars with the `!!js` tag: `apiKey: !!js process.env.DEEPSEEK_API_KEY`. Never commit real credentials; CI has no secrets and e2e suites must self-skip without them.

Dev/test/demo run **unbuilt** via tsx + the `paths` map in the root `tsconfig.json` (`vitest` resolves through `tsconfig.test.json`). Building is only needed for publishing/consumption outside the repo — with one exception: `pnpm run lint`'s type-aware rules resolve vendor packages through their built declarations (`tsconfig.typecheck.json` → `vendor/*/lib`), so run `pnpm run typecheck` once after a fresh clone (CI does the same) or lint reports unresolved-type `no-unsafe-*` errors.

## Conventions

- **Package naming**: every npm package in this repo is `@deepseek-ai/dsh-<name>` (vendored packages keep their upstream names and are `private: true`).
- **ESM everywhere** (`"type": "module"`); imports between workspace packages use package names, never relative paths across package boundaries. In-package imports use explicit `.ts` extensions (allowImportingTsExtensions).
- **`cordis` is a peerDependency** (+ devDependency) of every harness package, mirroring upstream convention.
- **Registrations are effects**: anything a plugin contributes (adapter, tool, section, agent, event listener) goes through `ctx.effect()` / `ctx.on()` so disposal and HMR work. If you write a registry, `register()` must return the disposer.
- **Typed events via declaration merging**: services declare their events in `declare module 'cordis' { interface Events { … } }`, and their ctx key in `interface Context`. Extensible unions use the merge-extensible-map pattern (see `ContentBlockMap`, `MessageSourceMap`).
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)` and MUST call `next()` to delegate; returning without it short-circuits. This is the veto mechanism — use deliberately.
- **Discriminated unions: match, don't chain**: branch on a tagged union (`StreamChunk`, `FinishReason`, `SessionEvent`, …) with a `switch` on the tag, not a chain of `if (x.kind === '…')`. The switch narrows each arm so member-only fields (`finish.message`, `finish.code`) are reachable in the right case and a typo'd tag fails to compile. Prefer extracting a small typed helper (`finishError(finish: FinishReason)`) over inlining the branches at the call site.
- **Switch exhaustiveness**: switches over CLOSED unions (e.g. `StreamChunk`) end with `default: assertNever(value, 'context')` (from dsh-llm) so adding a variant breaks compilation at every switch that must handle it. Switches over MERGE-EXTENSIBLE unions (`SessionEventMap`, `ContentBlockMap`, `FinishReason`, …) must NOT use assertNever — plugin-added variants are valid unknown values; handle known cases and fall through `default` with a comment (the lint rule `switch-exhaustiveness-check` makes the choice explicit either way; a redundant disable directive is itself a lint error).
- **Plugins, not loop changes**: new behavior goes into a plugin on the documented extension seams (see the plugin sanity checklist in docs/architecture.md). Changing `agent-loop` requires updating that doc.
- **Capability seams are three packages**: when adding a swappable capability (an execution backend, a provider integration, …), split it into *interface* (abstract service + vocabulary types, e.g. `bash/`), *implementation* (a concrete subclass, e.g. `bash-local/`), and *consumer* (what the model/plugins see, e.g. `tool-bash/`). Implementations and consumers then evolve independently — a sandboxed executor replaces `bash-local` without touching tool schemas. The LLM seam follows the same shape (`llm/` is interface + consumer surface; adapters are implementations). See docs/architecture.md § "Capability seams" for when NOT to split.
- **Explicit > implicit at package seams**: interface/vocabulary types spell out every field a consumer must supply — no optional field that the implementation silently fills with a hidden `?? default`. Put defaulting in the owning implementation as an explicit step (a `resolve(request): Spec` method that turns the optional-field request into the required-field spec), not smuggled inside `run()`/`start()`. Example: `dsh-bash` splits `BashExecRequest` (optional `workdir`/`timeoutMs`, model-facing) from `BashExecSpec` (required, what `run`/`start` act on); the tool layer calls `ctx.bash.resolve()` between them. The reader of a `BashExecSpec` never has to wonder where the working directory came from.
- **An empty `catch` must name what it swallows and why nothing else can hit it**: a bare `catch {}` hides bugs. When you deliberately ignore a throw, the comment must (a) name the single expected failure, (b) say why ignoring it is correct — usually because the useful state was already captured *before* the `try` — and (c) make clear nothing else of consequence can reach the catch (ideally the `try` wraps a single statement). Example: the error-body `response.json()` parse in `dsh-llm-deepseek`'s adapter sets `code` + HTTP `status` from the status line before the `try`, so a malformed provider body can only cost a richer message, never the real error.
- **Symmetry is usually more correct**: when two related values play parallel roles (a test fixture and its expected output, a request shape and its response shape, a buggy input and the test that checks the fix), give them parallel form — both named consts, or both inline, not one each way. Asymmetry is a smell that usually points at a missed extraction.
- **Merging PRs**: always merge with a **merge commit** (`gh pr merge --merge`), never squash or rebase. The per-PR commit history is intentional — review-fix commits, regression-test commits, and the reasoning in each message are part of the record — and squashing flattens it away.
- **TODO markers**: use `FIXME`/`TODO`/`XXX` to flag known issues by urgency — see [docs/development.md](docs/development.md) for the semantics of each.
- **Tests**: vitest, colocated under `packages/<name>/tests/*.spec.ts`. Every registry needs an HMR-safety test (dispose the contributing fiber, assert cleanup). **Excessive tests are welcome** — when in doubt, write the test; err on the side of covering edge cases, error paths, event ordering, and concurrency races even if they seem unlikely. Review findings get regression tests (see `packages/agent-loop/tests/review-fixes.spec.ts`).

## Defensive patterns (hard-won)

Each bullet is a bug class that bit us; the rule prevents the reoccurrence.

- **Report orthogonal outcomes independently.** A result can be several things at once (a process can both time out AND exit 0 because it trapped the signal). Don't nest the report of one flag inside the branch of another. Surface each independent fact (`timedOut`, `signal`, `exitCode`) on its own so a caller never reads a cut-short run as a clean success.
- **Honor cross-seam contracts on BOTH sides.** When an interface documents two valid ways to signal something (e.g. an adapter may report a model failure by THROWING from `stream()` *or* by ending the stream with a `finish {kind:'error'|'aborted'}` chunk), the consumer must handle both — not just the one the first implementation happened to use. A library-backed adapter that can't throw mid-stream relies on the finish-chunk path; if the loop only catches throws, a provider 401 becomes a normal completed turn. Document the contract where the type is defined and exercise every branch through the real consumer in tests.
- **Async state is not synchronous state.** `agent.send()` does not flip status to `running` before it returns; a background task's completion races turn boundaries; `reader.close()` fires for both EOF and disposal. Never gate control flow on a status you only *just* requested. Drive lifecycle off the events/promises that actually fire (`agent/status`, `task.done`), and when "done" needs a settle signal, observe the transition (saw `running` THEN `idle`) rather than counting actions you assume map 1:1 to turns — the loop batches queued messages into one turn. But a settle-signal guard cuts both ways: if the awaited transition can *never* occur (EOF with no work submitted → no turn ever starts → never `running`), it hangs forever. Always handle the "nothing to wait for" branch explicitly alongside the "wait for the work" branch.
- **Dispose must reach quiescence, not just request it.** A teardown that issues kills/aborts but returns before the work stops leaves orphans. Make cleanup `async` and `await` the children's exit (kill → await `done`), and close listener/notification registries *before* killing so late completions stay silent. Tests must prove disposal *waited* (pid already gone right after `await fiber.dispose()`), not merely that the process eventually dies.
- **Contain callback exceptions at the boundary.** A user-supplied listener (`onTaskDone`, event handlers) that throws must not reject the promise it runs inside or starve the listeners after it. Wrap the dispatch loop in try/catch and log; never let one bad subscriber break core lifecycle.
- **Never hand untrusted/model output the ambient environment or predictable paths.** Spawned commands get a scrubbed env (drop `*KEY*`/`*SECRET*`/ `*TOKEN*`) so the harness's own credentials can't leak into output, `env`, or spill files. Temp/spill files use a private (0700) dir, random names, and exclusive owner-only (`'wx'`, `0o600`) opens — predictable world-readable paths invite symlink races and disclosure.
- **e2e tests own their resources.** Real-API/integration tests must create the harness in the test and dispose it in `afterEach` (even on failure/retry/timeout), so a flaky run doesn't leak processes or contexts. Shared fixtures live in a plain `tests/harness.ts` module, NOT another `*.e2e.ts` file — importing a spec file re-registers its `describe` and duplicates real API calls. Verify the WORLD, not the agent's self-report: re-run the command/check externally and assert files are byte-identical where they should be unchanged (a keyword probe lets a cheating agent pass).
- **Tag spelling and EOF hygiene.** cordis.yml interpolates env via the `!!js` tag (js-yaml resolves custom tags under `tag:yaml.org,2002:js`), not `!js` — keep code, comments, and docs consistent. Files end with exactly one trailing newline; `git diff --check` (a pre-push gate) rejects new blank lines at EOF.

## Type Safety and Documentation

This codebase aims to be **very type-safe and well documented** for maintainability. Code that fails to compile under `strict: true` (with `noImplicitAny` enabled for all `packages/*` source) is not acceptable. Every `any` that remains must have a specific justification (a comment explaining why a narrower type is infeasible).

In the **core** packages (`packages/llm`, `packages/tools`, `packages/agent`, `packages/agent-loop`, `packages/session`, `packages/system-prompt`), **type gymnastics are acceptable when they improve the DX of plugin authors** for common plugin types. The `defineTool` typed schema DSL in `dsh-tools` is the canonical example: the `SchemaSpec` to `InferArgs<S>` type-level mapping gives tool authors zero-cast typed `execute` args, and the cost of the conditional types stays inside the core package.

Verbose documentation is fine **as long as docs and code stay strictly in sync**. Out-of-sync docs are worse than no docs. **When you change code, update its docs in the SAME change** — grep the package README and the module/JSDoc comments for the old behavior (config keys, defaults, error codes, wire field names, event names) and fix every hit. CI runs `pnpm run doc-sync` (`doc-typecheck` + `verify-event-taxonomy` + `verify-md-wrap` + `verify-md-links`), which typechecks every fenced `ts` block in `README.md`, `docs/**/*.md`, and `packages/*/README.md`, verifies the event-taxonomy table against source, asserts no hard-wrapped prose paragraphs, and checks that every relative Markdown cross-link resolves — across those files plus `AGENTS.md` / `packages/AGENTS.md` — but that scope does NOT catch prose drift in `AGENTS.md` / `packages/AGENTS.md` / `packages/README.md` (config keys, defaults, error codes), so keeping those in sync remains on the author. Every module has a module-level doc comment explaining its role. Every exported class, interface, type, function, and non-obvious method has a JSDoc that explains semantics (not just the name) — contracts (what events fire when), disposal behavior, error behavior, and extension intent. Internal helpers get docs only where non-obvious. Prefer one-liners when one line suffices.

**Write an RFC when — and only when — a PR makes a decision that is durable, contested, and surprising.** RFCs (`docs/rfc/`, grouped into `proposed/` / `implemented/` / `rejected/`) record the *why* behind choices a future reader would otherwise re-litigate (the vendoring policy, event-sourcing, the schema DSL are the existing examples). A PR that introduces such a decision — a new third-party runtime dependency over the vendoring default, a cross-package contract, a security/isolation model, a deviation from a documented architecture rule — writes the RFC in `implemented/` **in the same PR**, and links it from the relevant code. A proposal for future work not yet built goes in `proposed/`. A PR whose changes are mechanical, self-evident, or already covered by an existing RFC needs none — do not manufacture an RFC for a routine change. When unsure, the test is: would a competent maintainer six months from now ask "why was it done this way?" and be unable to answer from the code alone? If yes, write it. See [docs/rfc/README.md](docs/rfc/README.md) for the naming scheme and [docs/AGENTS.md](docs/AGENTS.md) for the cross-link convention.

**Markdown is not hard-wrapped**: write one line per paragraph and let the editor soft-wrap. Hard line breaks mid-paragraph make docs harder to edit and diff — a one-word change reflows and re-diffs the whole paragraph. This applies to prose only: leave fenced code blocks, tables, and list structure intact (a wrapped list item folds to one line per bullet). Code comments / JSDoc are exempt — they stay under the linter's column limit. `pnpm run verify-md-wrap` (part of `doc-sync`) enforces this across `README.md`, `docs/**/*.md`, `packages/*/README.md`, and `AGENTS.md` / `packages/AGENTS.md`; `pnpm run verify-md-links` (also part of `doc-sync`) checks that every relative cross-link in those files resolves.

**Editing these instructions**: `AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it (at the repo root and in `packages/`). Always edit `AGENTS.md` — never write through the `CLAUDE.md` symlink or replace it with a regular file.

## Vendoring Policy

`vendor/` packages are pinned source copies (manifest with upstream commit SHAs in [vendor/README.md](vendor/README.md)). To update one, follow the sync procedure there; re-apply (or retire) the logged local modifications and rerun `pnpm run test && pnpm run build`.
