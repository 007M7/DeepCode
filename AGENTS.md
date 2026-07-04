# AGENTS.md

This is the monorepo for the DeepSeek Harness group. It currently hosts the code for **DeepSeek Code**, DeepSeek's coding agent product.

## Pre-release stance: foundation over blast radius

**This applies only while the harness is unreleased — remove this section at the first tagged/published release.** There are no external consumers yet, so optimize for the *correct foundation*, not for a small diff. When the right structure means moving a file across package boundaries, renaming a public symbol, or repackaging a plugin, do it — and update every reference in the same change. Do **not** add backward-compat shims, deprecation aliases, re-export stubs, or "keep it where it is to avoid churn" hedges; those are debts you take on to protect callers you do not have. Churn now is cheap; a wrong foundation set in stone is not. (Once released, this inverts — backward compatibility becomes a real constraint and this section comes out.)

This extends to **on-disk formats, schemas, and stored data**: while unreleased there is no persisted user data to preserve, so a format/schema/contract change needs **no migration path** — a backend REJECTS anything not at the current version rather than upgrading it. How the *version number itself* behaves pre-release is a per-format choice between two equally-valid stances, and the repo uses both deliberately. **Monotonic bump-and-reject**: each breaking change increments the version — e.g. the SQLite backend's `SCHEMA_VERSION` bump that drops columns rejects any non-current `user_version` on open, with no migration; use it when a stored artifact has a small enumerable set of revisions worth telling apart. **A pinned `0` "unstable / pre-release" version**: the format stays at `0` and absorbs ALL pre-release shape churn without bumping, while a backend still rejects any non-`0` log — the session event log uses this (`SESSION_FORMAT_VERSION = 0` in `dsh-session`), because its shape changes often while unreleased and bumping on every tweak would dress up an unstable format as a sequence of stable boundaries that mean nothing yet; pinning `0` and documenting it "no compatibility implied" makes the instability *explicit* instead of pretending each revision is a real version. Either way there is no migration code, and either way a real monotonic policy begins at the first tagged release. A migration written now is a shim for data that does not exist.

## Tests document behavior, not golden truth

A passing test pins the behavior the code **currently** has — not necessarily the behavior it **should** have. Existing tests faithfully document existing behavior, but existing behavior is not automatically golden: it can be the residue of a past compromise, a half-built feature, or a limitation that no longer applies. So when a refactor or review makes you ask "can I change this?", a green test is **not** the answer — the question is whether the behavior the test pins is actually correct.

Before you preserve a behavior solely to keep a test green, ask: is this behavior load-bearing (a real consumer depends on it, a contract promises it, a user observes it), or is it an artifact? If it's an artifact, **change the behavior AND its test together, in the same change, and say why in the PR** — do not contort new code to keep an obsolete assertion passing, and do not treat "but the test expects X" as a reason X must stay. Conversely, do not delete a test just because it is inconvenient: the discipline cuts both ways — you must show the *behavior* is dead, not merely that the test is in your way.

The worked example is [Drop the mutable session summary](docs/rfc/implemented/simplification/2026-06-19-drop-mutable-session-summary.md): an entire `SessionSummary` type, a `SessionPersistence.update()` method, a JSONL sidecar, and SQLite columns existed and were exercised by their own contract test — yet **nothing in production CONSUMED any of it, and `update()` had no production caller**. (The backends did *write* summary state — JSONL touched the sidecar after a durable append, SQLite bumped `updated_at` in the append transaction — but those writes fed only reads that nothing performed.) The tests documented the behavior perfectly; the behavior was dead. Deleting the behavior and its tests together removed ~400 lines and erased a durability divergence the next refactor would have had to model. (This is the test-tier echo of "verify the world, not a synthetic stand-in" in § Defensive patterns: a test agrees with whatever it was written to assert; only a real consumer proves the behavior matters.)

## RFCs are proposals, not golden truth

The same discipline applies one level up, to the RFCs in `docs/rfc/`. A **proposed** RFC records an *intended* change argued at a point in time; it is not a contract to implement verbatim. The author reasoned from the code as they understood it then — and they can be wrong, or the code can have moved. So before implementing an RFC, **validate its premise against the current code first**: confirm the thing it wants removed or changed is actually dead/safe, and that the migration it proposes is genuinely cleaner than what exists.

When carrying out the change fights back — a removal forces an awkward migration, deletes machinery that turns out to be load-bearing, or pushes consumers onto a more brittle hand-rolled equivalent — treat that friction as **evidence the RFC over-reached**, not as work to push through. Keep, split, or amend the change to match what the code actually wants, and say so in the PR. An RFC that ships in amended form gets its text amended on the way to `implemented/`, so the landed RFC describes what actually shipped rather than the original guess. The discipline cuts both ways: an RFC is also not a reason to *avoid* a change a maintainer would otherwise make — it is one input, weighed against the code in front of you.

The worked example is [Keep one public stop primitive](docs/rfc/implemented/simplification/2026-06-20-public-agent-stop-surface.md): it proposed removing BOTH `Agent.abort()` and `Agent.whenIdle()` as redundant stop/quiescence surface. Validating against the code, `abort()` was genuinely dead — no production caller, the loop aborts its own `AbortController` directly — so it was removed as proposed. But `whenIdle()` was load-bearing: a deliberate quiescence primitive with live ACP consumers, and the RFC's suggested migration (observe the `running`→`idle` transition by hand) is exactly the brittle path § Defensive patterns warns against ("Async state is not synchronous state"). So only `abort()` shipped, `whenIdle()` stayed, and the RFC's text was amended on the way to `implemented/` to record the narrowed scope — the landed RFC is not a lie about what was built.

## Orchestrating review feedback across a stacked PR chain

A wave of review comments lands across several PRs in a dependent stack (`A ← B ← C …`) at once. Resolving it well is a discipline of its own, learned the hard way:

- **One worktree per PR branch; never rewrite a pushed branch.** Each PR's fixes happen in that PR's own worktree. To bring a child up to date with a parent's new commits, **merge the parent down** — never rebase/amend/force-push a branch that is already pushed (see [§ Conventions](#conventions) "Never rewrite a pushed branch"). The stacked-merge graph and the per-round review-fix history depend on it.
- **A fix belongs on the PR that INTRODUCED the issue, then flows DOWN.** When a comment on PR `B` points at code `B` introduced, fix it on `B` and merge `B` into `C` — even if `C` already carries the same file through the chain. Originating the fix on the downstream `C` leaves `B` shipping the unfixed code and the fix invisible to a reviewer of `B`. (This bit us: a snapshot-test guard flagged on the lower PR got fixed only on the top PR, so the lower PR still read as unaddressed until the fix was relocated to its true origin and merged down.)
- **Each review fix is a SEPARATE commit, never an amend.** The "fix review findings" commit is part of the record — it shows what the review caught and how. Amending erases that. (Amend is fine only for your own not-yet-pushed work.)
- **Delegated work is trust-but-verify.** When sub-agents implement fixes in parallel, their report describes what they INTENDED, not necessarily what landed. Re-run the gates yourself on the actual tree, and for a regression guard, **prove it FAILS on the unfixed code** (introduce the regression, watch the test go red, revert) — a guard that passes both ways guards nothing. A sub-agent that "reframes the problem as already-handled" instead of fixing it is a signal to dig in personally, not to accept the reframing.
- **Triage on the merits, then reply in-thread.** Verify each comment against the code before acting (a reviewer flagging the right symptom can still mis-diagnose the cause — confirm both). Reply in the GitHub review thread (`gh api …/pulls/{pr}/comments/{id}/replies`), not as a top-level comment, stating the fix and the commit that carries it.

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
packages/    Harness packages, grouped by role at packages/<group>/<pkg>/.
             Every package is named @deepseek-ai/dsh-<pkg>; the group dir is a
             pure container (no package.json). See packages/README.md and each
             group's README.md for the product-vs-support split.
  core/           product API spine
    session/        event-sourced session log + in-memory store
    system-prompt/  prompt-section + tool-schema assembly registry
    tools/          tool registry + tools/pre-execute/post-execute pipeline
    agent/          Agent interface, registry, agent/* event vocabulary
    agent-loop/     THE concrete plugin: ReactLoopAgent + the loop driver
    agent-core/     bundle plugin: the providerless/executor-less/UI-less spine
                    (timer+llm+sessions+system-prompt+tools+agents+invariants+
                    tool-bash+agent-loop) as code; forwards agent-loop's `agents`
  llm/            LLM capability family
    llm/            abstract LLM service + content-block vocabulary
    llm-deepseek/   DeepSeek API adapter (hand-rolled fetch/SSE)
    llm-pi-ai/      DeepSeek adapter via @earendil-works/pi-ai (design twin)
  bash/           bash capability family
    bash/           abstract bash executor seam (ctx.bash) — interface only
    bash-local/     local-subprocess BashExecutor implementation
    tool-bash/      model-facing bash/bash_output/bash_kill tool schemas
  compact/        compaction capability family
    compact/        abstract compaction seam (ctx.compact); backend + tool deferred
  subagent/       subagent capability family
    subagent/       provider-registry seam (ctx.subagents)
    subagent-inprocess/ shared in-process run driver (library, registers nothing)
    subagent-spawn/ in-process fresh-child backend
    subagent-fork/  in-process backend seeded from the parent's completed-turn prefix
    subagent-acp/   out-of-process child over ACP
    tool-subagent/  model-facing delegation tool over ctx.subagents
  todo/           todo/planning capability family
    tool-todo/      model-facing todo_write tool: writes the whole task list to
                    the session log (todo/write), rendered as a stdio checklist /
                    ACP plan
  hooks/          hook bridges + shared wire protocol
    hook-protocol/  shared Claude Code / Codex hook wire-protocol core (library,
                    not a plugin): matcher primitive, exit-code/stdout codec,
                    runHook (via ctx.bash), most-restrictive merge, hook/* events
  session-persistence/   persistence capability family
    session-persistence/         durable persistence seam + write coordinator
    session-persistence-jsonl/    JSONL-sidecar backend
    session-persistence-sqlite/   SQLite backend
  ui/             product integration surfaces
    acp/            Agent Client Protocol bridge: drive the agent from an ACP
                    editor (Zed) over JSON-RPC stdio
    stdio-agent/    stdio chat APP: agent-core spine + console logger + readline
                    UI + a pre-created main agent + a bin (the demo:echo/repl
                    front door)
    acp-agent/      ACP server APP: agent-core spine + JSONL persistence + the
                    acp bridge, NO stdout logger + a bin (the demo:acp front door)
  support/        dev/test/example infrastructure (lower compat expectations)
    invariants/     dev-mode event-contract invariants + session-log freeze
    ui-stdio/       minimal stdio (readline) UI plugin: renders agent/* events,
                    feeds stdin lines to the agent (shared by the demos)
    llm-replay/     record/replay adapter: short-circuits llm/stream from a
                    recorded session JSONL (keyless snapshot tests)
    subagent-mock/  scripted SubagentProvider for deterministic seam/tool tests
  util/           low-level zero-dependency utilities shared across groups
    brand/          type-only Branded<B> nominal-typing primitive (no runtime
                    code, no harness deps; owns the brand for cross-boundary ids)
examples/    Runnable demos (not workspaces; see examples/AGENTS.md). Each is a
             THIN leaf cordis.yml: it picks the swappable backends (an LLM adapter,
             a bash executor), loads ONE app package (dsh-stdio-agent or
             dsh-acp-agent), and may add optional product tools or demo-local
             teaching plugins. The app package bundles the agent-core spine +
             front-door cluster + boot glue (a bin). No start.ts. echo-agent =
             mock model + echo tool on dsh-stdio-agent (pnpm run demo:echo, no
             key). coding-agent = the REPL agent demo: DeepSeek V4 + fs tools
             (read/write/edit) + bash tools + subagent + todo_write on the same
             app (pnpm run demo:repl, needs DEEPSEEK_API_KEY). acp-agent = the
             ACP server agent demo on dsh-acp-agent (pnpm run demo:acp,
             needs DEEPSEEK_API_KEY).
             cordis.snapshot.yml = the acp leaf with llm-replay for keyless
             snapshot replay.
docs/        architecture.md — the design doc. module-graph.md — generated
             inter-package dependency graph (Mermaid; `pnpm run gen-module-graph`).
             rfc/ — design decisions and proposals, one kind of doc grouped by
             lifecycle (proposed/ implemented/ rejected/) then by class
             (feature/ bug-fix/ simplification/ architecture/ process/ testing/);
             the why behind vendoring, event-sourcing, the schema DSL, …. See
             rfc/README.md.
             postmortem/ — incident write-ups: a bug that escaped to a
             user/merge/release, why the safety nets missed it, the guardrails added.
             cookbook/ — step-by-step guides: adding a package, a tool,
             an LLM adapter.
scripts/     repo maintenance scripts (vendor-manifest guard, publint runner).
             JS bundling is tsdown (root tsdown.config.ts + two per-package
             overrides in vendor/).
```

## Commands

```sh
pnpm install        # pnpm workspaces, node >= 24
pnpm run test           # vitest run (packages|examples/*/tests/**/*.spec.ts)
pnpm run test:coverage  # vitest run --coverage (per-file 100% gate on packages/*/*/src)
pnpm run test:e2e       # real-API tests (packages|examples/*/tests/**/*.e2e.ts);
                    # self-skips without DEEPSEEK_API_KEY — see Secrets below
pnpm run test:snapshot  # ACP snapshot tests (examples/*/tests/**/*.snapshot.ts):
                    # boot the real acp-agent subprocess, replay a recorded
                    # session JSONL, diff the normalized stdout + re-persisted
                    # log against committed goldens. KEYLESS — runs in the
                    # default gate. Filter one by scenario name (no `--`, which
                    # vitest treats as a positional file filter): `pnpm run
                    # test:snapshot -t <name>`.
pnpm run test:snapshot:record  # re-record fixtures + goldens against the real
                    # API (needs DEEPSEEK_API_KEY); accept-the-diff = re-record
                    # (or `pnpm run test:snapshot -u` to refresh goldens only)
pnpm run typecheck      # tsc -b tsconfig.json
pnpm run lint           # eslint .
pnpm run lint:fix       # eslint . --fix
pnpm run build          # tsc emits lib/types, then tsdown bundles runtime lib/index.*
pnpm run knip           # dead-code / unused-dependency check
pnpm run publint        # package.json publish-correctness check (every packages/*/* package)
pnpm run hygiene        # knip + publint + workspace constraints + NodeNext type-consumer check
pnpm run doc-typecheck  # typecheck every ```ts block in README.md, docs/**/*.md,
                    # packages/*/*.md + packages/*/*/*.md (doc/code drift gate)
pnpm run gen-cordis-catalog  # regenerate docs/cordis-catalog/events-and-services.md
                    # (events + services) from the interface Events / Context source
pnpm run verify-cordis-catalog  # assert that generated catalog is not stale
pnpm run verify-md-wrap  # assert no hard-wrapped prose paragraphs in README.md,
                    # docs/**/*.md, packages/*/*.md, AGENTS.md (one line per paragraph)
pnpm run verify-doc-refs  # assert every docs/*.md path cited in a packages|examples
                    # TypeScript comment resolves (catches a moved/renamed doc)
pnpm run verify-package-paths  # assert every packages/<path> cited in Markdown or a
                    # TypeScript comment resolves when it names a real (moved) package
pnpm run verify-rfc-classification  # assert every RFC lives in a valid
                    # {lifecycle}/{class}/ folder and docs/rfc/README.md lists it
                    # under the matching heading (closed class set + index completeness)
pnpm run verify-translation-pairing  # assert the bilingual pairing contract
                    # (docs/i18n/README.md): required docs have a complete pair
                    # (foo.md + foo.zh.md + foo.i18n.yaml); every pair matches its
                    # recorded consistency hashes, is switcher-linked, and
                    # structure-matched. `--list` prints the work list; `--write`
                    # re-records a pair after you bring both sides in line
pnpm run verify-node-next-types  # assert built declarations typecheck for a
                    # standard external NodeNext ESM TypeScript consumer
pnpm run doc-sync       # doc-typecheck + verify-cordis-catalog + verify-tool-catalog + verify-md-wrap + verify-md-links + verify-doc-refs + verify-package-paths + verify-rfc-classification + verify-type-equiv + verify-translation-pairing (CI runs this)
pnpm run demo:echo      # run examples/echo-agent (no API key; type "echo hi" to
                    # see a tool call) — the mock skeleton
pnpm run demo:repl      # run examples/coding-agent — the REPL agent demo
                    # (needs DEEPSEEK_API_KEY; give it a coding task)
pnpm run demo:acp   # run examples/acp-agent — the ACP server agent demo
                    # over JSON-RPC stdio (needs DEEPSEEK_API_KEY;
                    # drive it from Zed or another ACP client)
```

### Run the CI gates locally BEFORE marking a PR ready

CI is the backstop, not the first place a gate runs. Before you open a non-draft PR or move one from draft to ready, run the same gates CI runs, on your own tree, and confirm they pass — do not lean on CI (or a Codex pass) to discover a red gate you could have caught locally. The CI-equivalent local run is:

```sh
set -euo pipefail
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run test:snapshot
pnpm run doc-sync
pnpm run verify-module-graph
pnpm run build
pnpm run hygiene
out=$(printf 'echo ci smoke\n' | pnpm run demo:echo 2>&1)
printf '%s\n' "$out" | grep -q '\[tool call\] echo({"text":"ci smoke"})'
printf '%s\n' "$out" | grep -q '\[tool result\] ECHO: CI SMOKE'
ls .sessions/_no-cwd/main-session-*.jsonl >/dev/null
rm -rf .sessions
pnpm exec vitest run --config vitest.e2e.config.ts packages/ui/stdio-agent/tests/built-bin.e2e.ts packages/ui/acp-agent/tests/built-bin.e2e.ts
```

**`pnpm run test:coverage`, NOT `pnpm run test`, is the gating test command.** `pnpm run test` runs `vitest run` with no coverage; CI's node job runs `test:coverage`, which enforces a **per-file 100%** threshold on `packages/*/*/src`. A suite that is green under `test` can still fail CI on an uncovered line — and that uncovered line is often *dead code* the 100% gate is correctly flagging for deletion (see [§ Defensive patterns](#defensive-patterns-hard-won) "Line coverage is not behavior coverage"), not a missing test to bolt on. `hygiene` (knip + publint + workspace constraints + NodeNext types) and `test:snapshot` (keyless ACP replay) are likewise CI gates that `test` alone does not cover. When you rely on a Codex convergence pass for sign-off, check WHICH commands it ran: a pass that ran `test` but not `test:coverage`/`hygiene`/`doc-sync` has not exercised those gates.

## Secrets / .env

Real-API e2e tests (`pnpm run test:e2e`) read `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_BASE_URL`) from the environment, or from a gitignored `.env` at the repo root loaded via Node's native `process.loadEnvFile()`:

```
DEEPSEEK_API_KEY=sk-…
DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
```

cordis.yml configs reference env vars with the `!!js` tag: `apiKey: !!js process.env.DEEPSEEK_API_KEY`. Never commit real credentials; CI has no secrets and e2e suites must self-skip without them.

**Lean on with-key e2e tests — we are DeepSeek and model inference is cheap.** A no-key test (mock adapter, or an operation that never reaches the model) is great for determinism and CI, but it can only prove the plumbing, not that the agent actually *works* against a real model. Do not ration real-API tests to save tokens: write many of them, cover the real flows (a real prompt that writes a file, a multi-turn conversation, tool use, cancellation mid-stream), and run them frequently while developing — locally and whenever you have a key in the environment. **Especially smoke tests**: a cheap with-key smoke test that boots the real example, sends one real prompt, and checks the world (a file on disk, a non-empty assistant turn) catches whole classes of "green unit tests, broken product" failures that mocks structurally cannot — the very gap that let the ACP inject bug ship (see [docs/postmortem/0001](docs/postmortem/0001-acp-default-export-drops-inject.md)). The self-skip rule is ONLY so CI (which has no secrets) stays green and so a contributor without a key isn't blocked — it is not a signal that real-API tests are expensive or second-class. When in doubt, add the with-key test AND run it.

Dev/test/demo run **unbuilt** via tsx + the source `paths` map in the root `tsconfig.json` (`vitest` resolves through that same root config). Building is only needed for publishing/consumption outside the repo. Non-published code (`examples`, tests, and scripts) is checked by root `tsconfig.json`, which sets `noEmit` and references the package/vendor graph so those sources stay checked under their own tsconfig boundaries.

## Conventions

- **Package naming**: every npm package in this repo is `@deepseek-ai/dsh-<name>` (vendored packages keep their upstream names and are `private: true`).
- **ESM everywhere** (`"type": "module"`); imports between workspace packages use package names, never relative paths across package boundaries. In-package relative imports use explicit `.ts` extensions; `rewriteRelativeImportExtensions` turns those into `.js` in emitted JS, while declarations keep explicit `.ts` specifiers that NodeNext/Node16 TypeScript consumers can resolve to sibling `.d.ts` files. `lib/types/**/*.js` is a bundler-only intermediate, not a Node ESM entrypoint.
- **`cordis` is a peerDependency** (+ devDependency) of every harness package, mirroring upstream convention.
- **Registrations are effects**: anything a plugin contributes (adapter, tool, section, agent, event listener) goes through `ctx.effect()` / `ctx.on()` so disposal and HMR work. If you write a registry, `register()` must return the disposer.
- **Typed events via declaration merging**: services declare their events in `declare module 'cordis' { interface Events { … } }`, and their ctx key in `interface Context`. Extensible unions use the merge-extensible-map pattern (see `ContentBlockMap`, `MessageSourceMap`).
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)` and MUST call `next()` to delegate; returning without it short-circuits. This is the veto mechanism — use deliberately.
- **Discriminated unions: match, don't chain**: branch on a tagged union (`StreamChunk`, `FinishReason`, `SessionEvent`, …) with a `switch` on the tag, not a chain of `if (x.kind === '…')`. The switch narrows each arm so member-only fields (`finish.message`, `finish.code`) are reachable in the right case and a typo'd tag fails to compile. Prefer extracting a small typed helper (`finishError(finish: FinishReason)`) over inlining the branches at the call site.
- **Switch exhaustiveness**: switches over CLOSED unions (e.g. `StreamChunk`) end with `default: assertNever(value, 'context')` (from dsh-llm) so adding a variant breaks compilation at every switch that must handle it. Switches over MERGE-EXTENSIBLE unions (`SessionEventMap`, `ContentBlockMap`, `FinishReason`, …) must NOT use assertNever — plugin-added variants are valid unknown values; handle known cases and fall through `default` with a comment (the lint rule `switch-exhaustiveness-check` makes the choice explicit either way; a redundant disable directive is itself a lint error).
- **Plugins, not loop changes**: new behavior goes into a plugin on the documented extension seams (see the plugin sanity checklist in docs/architecture.md). Changing `agent-loop` requires updating that doc.
- **Capability seams are three packages**: when adding a swappable capability (an execution backend, a provider integration, …), split it into *interface* (abstract service + vocabulary types, e.g. `bash/`), *implementation* (a concrete subclass, e.g. `bash-local/`), and *consumer* (what the model/plugins see, e.g. `tool-bash/`). Implementations and consumers then evolve independently — a sandboxed executor replaces `bash-local` without touching tool schemas. The LLM seam follows the same shape (`llm/` is interface + consumer surface; adapters are implementations). See docs/architecture.md § "Capability seams" for when NOT to split.
- **Explicit > implicit at package seams**: interface/vocabulary types spell out every field a consumer must supply — no optional field that the implementation silently fills with a hidden `?? default`. Put defaulting in the owning implementation as an explicit step (a `resolve(request): Spec` method that turns the optional-field request into the required-field spec), not smuggled inside `run()`/`start()`. Example: `dsh-bash` splits `BashExecRequest` (optional `workdir`/`timeoutMs`, model-facing) from `BashExecSpec` (required, what `run`/`start` act on); the tool layer calls `ctx.bash.resolve()` between them. The reader of a `BashExecSpec` never has to wonder where the working directory came from.
- **Opaque cross-boundary ids are branded, never bare `string`**: an identity that crosses a package seam and that a consumer must store-and-return but never parse (a backend-defined version token, a target key, a task/session/call id) is a `Branded<B>` from `@deepseek-ai/dsh-brand` with a same-named cast factory in the owning package — a zero-cost compile-time guard so semantically-distinct strings stop being interchangeable. Not every string needs it: author-readable names (`ToolName`) and closed code unions (`ErrorCode`) don't. See [Branded IDs everywhere they belong](docs/rfc/implemented/architecture/2026-06-20-branded-ids.md).
- **An empty `catch` must name what it swallows and why nothing else can hit it**: a bare `catch {}` hides bugs. When you deliberately ignore a throw, the comment must (a) name the single expected failure, (b) say why ignoring it is correct — usually because the useful state was already captured *before* the `try` — and (c) make clear nothing else of consequence can reach the catch (ideally the `try` wraps a single statement). Example: the error-body `response.json()` parse in `dsh-llm-deepseek`'s adapter sets `code` + HTTP `status` from the status line before the `try`, so a malformed provider body can only cost a richer message, never the real error.
- **Symmetry is usually more correct**: when two related values play parallel roles (a test fixture and its expected output, a request shape and its response shape, a buggy input and the test that checks the fix), give them parallel form — both named consts, or both inline, not one each way. Asymmetry is a smell that usually points at a missed extraction.
- **Merging PRs**: always merge with a **merge commit** (`gh pr merge --merge`), never squash or rebase. The per-PR commit history is intentional — review-fix commits, regression-test commits, and the reasoning in each message are part of the record — and squashing flattens it away.
- **Never rewrite a pushed branch in a stacked chain.** Once a branch is pushed (and especially once it has a PR), do NOT `rebase`, `amend`, or force-push it. Update a child branch by **merging its parent down** (`git merge <parent-branch>` into the child, as a new merge commit), never by rebasing the child onto the parent's new tip. Rewriting a shared branch diverges it from what the parent and GitHub recorded, which breaks the stacked-merge graph and erases the review-fix history that documents what each round caught. Amending is fine ONLY for your own not-yet-pushed, not-yet-reviewed work. A corollary on WHERE a fix lands: a review fix belongs on the PR that **introduced** the issue, even when a downstream PR in the stack also carries the affected file — fix it on the originating branch, then merge that branch DOWN the chain, rather than originating the fix on the downstream PR (where it would be invisible to a reviewer of the PR that actually owns the code).
- **TODO markers**: use `FIXME`/`TODO`/`XXX` to flag known issues by urgency — see [docs/development.md](docs/development.md) for the semantics of each.
- **Tests**: vitest, colocated under `packages/<group>/<pkg>/tests/*.spec.ts`. Every registry needs an HMR-safety test (dispose the contributing fiber, assert cleanup). **Excessive tests are welcome** — when in doubt, write the test; err on the side of covering edge cases, error paths, event ordering, and concurrency races even if they seem unlikely. Review findings get regression tests (see `packages/core/agent-loop/tests/review-fixes.spec.ts`). The same generosity applies to **real-API (with-key) e2e tests — inference is cheap here (we are DeepSeek), so do not ration them**: cover the agent's real flows (a real prompt that writes a file, multi-turn, tool use, cancellation) and run them frequently while developing, especially cheap **smoke tests** that boot the real example and check the world. A green mock/no-key suite proves the plumbing, not the product — the with-key smoke test is what catches "green units, broken product". See § Secrets / .env for the with-key policy and why self-skip is a CI accommodation, not a verdict that real-API tests are expensive.
- **Prefer the REAL implementation over a mock/stand-in in tests.** When the genuine collaborator is available in the repo, wire it up instead of hand-rolling a fake — a test that registers an inline `defineTool({ name: 'bash', … })` to stand in for `dsh-tool-bash` proves the *bridge* moves bytes but not that the *shipping tool* renders the way the test asserts; the two drift and the test passes while the product is wrong. Mock only the genuinely expensive/non-deterministic boundary (the LLM adapter, the network, the clock) and keep everything downstream real: a bridge tool-call test runs the scripted mock MODEL but the REAL tool + REAL executor (e.g. `makeBridgeHarness({ withBash: true })` plugs `dsh-bash-local` + `dsh-tool-bash` and runs an actual `echo`), so it verifies the actual `presentCall`/`presentResult` an editor sees. This is the unit-test echo of "verify the world, not a synthetic stand-in" (see § Defensive patterns) — a fake you wrote will agree with whatever you assumed; the real thing won't.
- **A change that affects the editor-facing transcript or end-to-end agent UX needs a snapshot test (or an explicit note in the PR why none applies).** The snapshot tier (`examples/*/tests/**/*.snapshot.ts`, `pnpm run test:snapshot`) boots the real example subprocess, replays a recorded session JSONL deterministically (keyless), and diffs the normalized stdout transcript + re-persisted session log against committed goldens — the full-transcript regression net that mock-level unit tests structurally cannot be (it is what catches a bridge-translation or loop-structure regression that leaves every unit green). When you change the ACP bridge, the agent loop's observable output, tool presentation, or anything an editor renders, add or update a scenario under `examples/acp-agent/tests/snapshots/` and re-record with `pnpm run test:snapshot:record`. Reviewing the golden diff is part of the review. The rule is scoped to transcript/UX-affecting changes — a pure internal refactor with no observable-output change does not need one, but say so. See [docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md](docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md).
- **A tool's editor/ACP representation is part of its design — decide it up front, not after.** When you add or change a model-facing tool, its ACP tool-call card is as much a deliverable as its `execute`: decide which render intent it declares via `presentCall`/`presentResult` (`generic` — a titled card with `kind`/`rawInput`/`content`/`locations`; `terminal` — a shell command; `diff` — a file create/modify rendered as an inline diff), and cover it with a snapshot test (the transcript tier is the only place card rendering is actually verified end-to-end — a unit test on the pure presenter proves the shape, not that an editor renders it). A tool that reads/writes files should almost always emit `locations` (for editor follow-along) and, for a mutation, a `diff` card; a tool that runs a command is a `terminal`. The presentation methods are pure functions of `args` (they run on live streaming AND session-log replay), so they must not do I/O or read session state — the bridge, not the tool, relativizes display paths and fills the session cwd. The reference implementations are `dsh-tool-fs` (generic/diff) and `dsh-tool-bash` (terminal); the vocabulary and the why are pinned in [docs/rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md](docs/rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md), and the step-by-step is in [docs/cookbook/adding-a-tool.md](docs/cookbook/adding-a-tool.md). When you introduce a new capability seam, a new agent-lifecycle shape, or anything that produces an observable transcript (a new tool family, a subagent transport, a new UI surface), the plan must name how it will be covered at EVERY tier it touches — unit, real-API e2e, AND the full-transcript snapshot tier — and, critically, must check that the existing test infrastructure can actually express that coverage. Do not assume a snapshot/e2e harness built for one shape (e.g. a single top-level ACP session) transparently supports a new shape (e.g. a parent agent driving nested child agents): verify it, and if it cannot, the harness extension is in-scope work to plan and schedule, not a detail to discover mid-implementation. This rule exists because a real plan under-scoped exactly this: the subagent backends were planned with unit + e2e coverage but the snapshot tier turned out to assume one session per process (`dsh-llm-replay`'s single positional cursor, single-file harvest), so nested-agent snapshot coverage became unplanned net-new infrastructure (`TODO(subagent-snapshots)`). The cost of finding that during design is a paragraph; the cost of finding it mid-build is a re-plan. When the harness gap is large enough to be its own reviewable unit, schedule it as a dedicated stacked follow-up with its own RFC — but SAY SO in the originating plan, with the gap named, rather than letting it surface as a surprise.

## Defensive patterns (hard-won)

Each bullet is a bug class that bit us; the rule prevents the reoccurrence.

- **Report orthogonal outcomes independently.** A result can be several things at once (a process can both time out AND exit 0 because it trapped the signal). Don't nest the report of one flag inside the branch of another. Surface each independent fact (`timedOut`, `signal`, `exitCode`) on its own so a caller never reads a cut-short run as a clean success.
- **Honor cross-seam contracts on BOTH sides.** When an interface documents two valid ways to signal something (e.g. an adapter may report a model failure by THROWING from `stream()` *or* by ending the stream with a `finish {kind:'error'|'aborted'}` chunk), the consumer must handle both — not just the one the first implementation happened to use. A library-backed adapter that can't throw mid-stream relies on the finish-chunk path; if the loop only catches throws, a provider 401 becomes a normal completed turn. Document the contract where the type is defined and exercise every branch through the real consumer in tests.
- **Async state is not synchronous state.** `agent.send()` does not flip status to `running` before it returns; a background task's completion races turn boundaries; `reader.close()` fires for both EOF and disposal. Never gate control flow on a status you only *just* requested. Drive lifecycle off the events/promises that actually fire (`agent/status`, `task.done`), and when "done" needs a settle signal, observe the transition (saw `running` THEN `idle`) rather than counting actions you assume map 1:1 to turns — the loop batches queued messages into one turn. But a settle-signal guard cuts both ways: if the awaited transition can *never* occur (EOF with no work submitted → no turn ever starts → never `running`), it hangs forever. Always handle the "nothing to wait for" branch explicitly alongside the "wait for the work" branch.
- **Dispose must reach quiescence, not just request it.** A teardown that issues kills/aborts but returns before the work stops leaves orphans. Make cleanup `async` and `await` the children's exit (kill → await `done`), and close listener/notification registries *before* killing so late completions stay silent. Tests must prove disposal *waited* (pid already gone right after `await fiber.dispose()`), not merely that the process eventually dies.
- **Contain callback exceptions at the boundary.** A user-supplied listener (`onTaskDone`, event handlers) that throws must not reject the promise it runs inside or starve the listeners after it. Wrap the dispatch loop in try/catch and log; never let one bad subscriber break core lifecycle.
- **Never hand untrusted/model output the ambient environment or predictable paths.** Spawned commands get a scrubbed env (drop `*KEY*`/`*SECRET*`/ `*TOKEN*`) so the harness's own credentials can't leak into output, `env`, or spill files. Temp/spill files use a private (0700) dir, random names, and exclusive owner-only (`'wx'`, `0o600`) opens — predictable world-readable paths invite symlink races and disclosure.
- **e2e tests own their resources.** Real-API/integration tests must create the harness in the test and dispose it in `afterEach` (even on failure/retry/timeout), so a flaky run doesn't leak processes or contexts. Shared fixtures live in a plain `tests/harness.ts` module, NOT another `*.e2e.ts` file — importing a spec file re-registers its `describe` and duplicates real API calls. Verify the WORLD, not the agent's self-report: re-run the command/check externally and assert files are byte-identical where they should be unchanged (a keyword probe lets a cheating agent pass).
- **Line coverage is not behavior coverage; test the REAL entry path, not a synthetic stand-in.** 100% per-file coverage and a green suite are necessary, not sufficient — they prove lines ran, not that the feature works the way it ships. A plugin shipped via `cordis.yml` is loaded by the cordis Loader, which calls `Loader.unwrapExports` (`exports.default ?? exports`) and then constructs a fiber from the module's `inject`/`name`/`Config` namespace exports. A test that mounts the plugin by hand-building `ctx.plugin({ name, inject, apply })` (or even `ctx.plugin(NamespaceImport)`) BYPASSES `unwrapExports` entirely, so it cannot catch a broken export shape. This bit us hard: a stray `export default apply` made `unwrapExports` collapse the module to the bare function, dropping `inject` — so every service read threw `cannot get property … without inject` the instant a real editor connected, while 178 hand-mounted tests stayed green. The guard is at least one test that drives the plugin through its REAL load path (a subprocess booting the example via the Loader, or the Loader API directly), exercising the headline operations end-to-end. It runs WITHOUT a key when the operation doesn't call the model (`session/new`/`session/load` reach the factory but never the LLM), so there is no excuse to skip it. Corollary: when an `*.e2e.ts` spawns the example from a temp cwd, set `TSX_TSCONFIG_PATH` to the repo-root tsconfig — the unbuilt `paths` map is found by searching UP from cwd, so a temp cwd outside the repo silently falls back to built `lib/`, which both hides source changes and only "works" when a stale build happens to exist. Two sharper corollaries this bit us with again:
  - **A real-load-path test only GUARDS the export shape if a broken shape actually FAILS it.** The original crash (`cannot get property … without inject`) fired because that plugin HAS `inject`. A plugin with NO `inject` (a composition/bundle plugin that mounts children carrying their own inject, e.g. `dsh-agent-core` and the app packages) does NOT crash on a stray `export default` — `unwrapExports` silently drops `Config`/`name` and the plugin boots anyway — so a Loader smoke stays green while the export shape is broken. For such plugins add an EXPLICIT assertion that the regression fails: `expect('default' in mod).toBe(false)` plus running the module through the real `Loader.prototype.unwrapExports` and asserting `name`/`Config`/`apply` survive. Prove it: add `export default apply`, watch the test go red, revert.
  - **"Real entry path" means the PUBLISHED ARTIFACT, not the dev runtime.** A test (or a `demo:*` smoke) that boots `src/bin.ts` under `tsx` is NOT the same code a consumer runs — the package `bin` field points at the built `lib/bin.js` under plain `node`. tsx masks failure modes the published artifact has: a boot settle-race that exits 0 before the app's handles attach, module-resolution differences (the unbuilt `paths` map vs node_modules), and a load failure that `loader.await()`'s `Promise.allSettled` SWALLOWS so a typo'd config silently exits 0. The guard is a smoke that runs the built `lib/bin.js` under plain `node` in a node_modules-shaped temp dir (symlinked workspace + vendor packages), asserts the real output, AND asserts a genuinely-missing config exits NON-ZERO. The tsx demo is necessary but not sufficient; the published-bin smoke is what catches "green under tsx, broken on install".
- **Tag spelling and EOF hygiene.** cordis.yml interpolates env via the `!!js` tag (js-yaml resolves custom tags under `tag:yaml.org,2002:js`), not `!js` — keep code, comments, and docs consistent. Files end with exactly one trailing newline; `git diff --check` (a pre-push gate) rejects new blank lines at EOF.

## Type Safety and Documentation

This codebase aims to be **very type-safe and well documented** for maintainability. Code that fails to compile under `strict: true` (with `noImplicitAny` enabled for all `packages/*/*` source) is not acceptable. Every `any` that remains must have a specific justification (a comment explaining why a narrower type is infeasible).

**Almost always lean toward the stricter lint rule.** In the agentic-coding era the cost/benefit of strictness has inverted: a machine writes and reads most of the code, so the one-time cost of satisfying a stricter rule is cheap and paid by a tool, while the benefit — a whole class of error caught mechanically, a consistent foundation every agent can rely on, less reviewer attention spent on what a linter could have caught — compounds across every future change. When choosing whether to enable a rule, tighten an existing one, or add a new gate (a `verify-*` script, a constraint check), default to YES unless it has a concrete, recurring false-positive problem. Prefer a narrowly-scoped escape hatch (a justified inline disable with a reason, a per-path override) over leaving the rule off globally. The same reasoning motivates this repo's many bespoke gates (`doc-sync`, `verify-package-paths`, the workspace-shape constraint): encode the invariant in a check so no human or agent has to remember it.

In the **core** packages (`packages/llm/llm`, `packages/core/tools`, `packages/core/agent`, `packages/core/agent-loop`, `packages/core/session`, `packages/core/system-prompt`), **type gymnastics are acceptable when they improve the DX of plugin authors** for common plugin types. The `defineTool` typed schema DSL in `dsh-tools` is the canonical example: the `SchemaSpec` to `InferArgs<S>` type-level mapping gives tool authors zero-cast typed `execute` args, and the cost of the conditional types stays inside the core package.

Verbose documentation is fine **as long as docs and code stay strictly in sync**. Out-of-sync docs are worse than no docs. **When you change code, update its docs in the SAME change** — grep the package README and the module/JSDoc comments for the old behavior (config keys, defaults, error codes, wire field names, event names) and fix every hit. CI runs `pnpm run doc-sync` (`doc-typecheck` + `verify-cordis-catalog` + `verify-tool-catalog` + `verify-md-wrap` + `verify-md-links` + `verify-doc-refs` + `verify-package-paths` + `verify-rfc-classification` + `verify-type-equiv` + `verify-translation-pairing`), which typechecks every fenced `ts` block in `README.md`, `docs/**/*.md`, and `packages/*/*.md`, regenerates the cordis events/services catalog from source and fails if the committed copy is stale, asserts no hard-wrapped prose paragraphs, checks that every relative Markdown cross-link resolves, checks that every `docs/*.md` path cited in a source comment resolves, checks that every `packages/<path>` reference naming a real package resolves, checks that every RFC is filed under a valid class folder and listed in its index, checks that every ` ```ts type-equiv ` doc block still matches its source type, and checks the bilingual pairing contract (required docs have a complete, consistency-recorded EN/ZH pair — see [docs/i18n/README.md](docs/i18n/README.md)) — across those files plus `AGENTS.md` / `packages/AGENTS.md` — but that scope does NOT catch prose drift in `AGENTS.md` / `packages/AGENTS.md` / `packages/README.md` (config keys, defaults, error codes), so keeping those in sync remains on the author. The same-change rule extends to translations: **editing either side of a paired doc means updating the counterpart and re-recording the pair in the SAME change** (run the [dsh-translate-docs](.agents/skills/dsh-translate-docs/SKILL.md) skill, then `pnpm run verify-translation-pairing --write`); the pairing gate goes red otherwise. Every module has a module-level doc comment explaining its role. Every exported class, interface, type, function, and non-obvious method has a JSDoc that explains semantics (not just the name) — contracts (what events fire when), disposal behavior, error behavior, and extension intent. Internal helpers get docs only where non-obvious. Prefer one-liners when one line suffices.

**Tag every new event with `@mode`.** The cordis events/services catalog ([docs/cordis-catalog/events-and-services.md](docs/cordis-catalog/events-and-services.md)) is GENERATED from source by `scripts/gen-cordis-catalog.ts` — never hand-edit it; run `pnpm run gen-cordis-catalog` and commit the result. When you add an event to an `interface Events` block, its JSDoc MUST carry a `@mode emit|waterfall|parallel|serial` tag (the generator hard-errors without it): use `waterfall` when the signature ends with a `next: () => …` parameter (the listener transforms or vetoes via `next()`), `parallel` when the loop awaits a fan-out and must run every listener (e.g. an awaited `Promise<void> | void` checkpoint like `session/flush`), `serial` when the loop awaits listeners in registration order and should isolate side effects (e.g. an ordered surface-mutation checkpoint like `agent/pre-step`; Cordis stops early if a listener returns a bail value, so `void` serial listeners must not return a semantic veto), and `emit` for plain fire-and-forget notifications. The generator also cross-checks the tag against the signature where the shape is conclusive (a trailing `next` ⇒ waterfall) and hard-errors on a contradiction. Write the rest of the event's JSDoc to stand alone — it is the catalog entry's prose.

**The core-data-structures catalog is a maintained surface, not a write-once artifact.** [docs/core-data-structures/](docs/core-data-structures/core.md) catalogs the spine vocabulary (core.md) and the per-seam types (sub-pages). When a change adds, removes, or reshapes a type the catalog documents — a new `…Map` variant, a new content-block or session-event type, a field on `GenerateOptions`/`Agent`/`ToolDefinition`/a bash type, or a whole new core/seam type — update the catalog in the SAME change: edit the prose, and for a pasted ` ```ts type-equiv ` block, re-copy it verbatim and keep `scripts/type-equiv.manifest.json` 1:1 with the blocks. The `verify-type-equiv` gate catches a *drifted paste* of an already-documented type, but it canNOT tell you a brand-new core type was never documented — that judgment is on the author and the reviewer. The definition of "core" (the spine-vs-seam line) is in [core.md § What counts as "core"](docs/core-data-structures/core.md#what-counts-as-core); a genuinely spine-level new type belongs in core.md, a new capability's vocabulary on a sub-page. See [development.md](docs/development.md#documenting-types-verbatim-ts-type-equiv) for the `ts type-equiv` mechanics.

**Document the CURRENT state — the "what" and "why" — never the PROCESS or HISTORY of how it got there.** A comment, JSDoc, or doc paragraph describes what the code *is* and why it is that way, as if it had always been so. Do NOT narrate the change that produced it: no "previously X, now Y", "changed from", "used to", "this replaces", "the old map", "renamed", "moved here", "as of this PR", or "(was …)". **In particular, NEVER name the change unit a reader cannot see — the PR, commit, or stack position that introduced the code — in a comment, JSDoc, OR a test name/description.** A `// (PR D's per-agent teardown)` aside, a `* Tests for the cancel primitive (PR C).` module doc, or an `it('… identity no longer matters')` title that only makes sense relative to a prior design are all the same violation: the reader of the current tree has no "PR D" or "old design" to anchor against, and the reference rots the moment the stack merges. Name the *mechanism* (`the session's AgentHandle teardown`), not the PR. Such phrasing rots the instant the next change lands, and a reader of the current code does not need the diff narrated in prose — that belongs in the commit message, the PR description, or an RFC (the durable home for "why we moved away from X"). Write "the owner token lives on the task in the executor" — not "ownership *now* lives on the executor instead of a plugin-local map". When a contrast genuinely aids understanding (a non-obvious choice between live alternatives), frame it against the alternative as a standing fact ("stored on the executor, NOT the tool plugin, so it survives an HMR reload"), not against the codebase's past. The same rule governs review-fix commits: the *commit message* records what the review caught; the *code comment* it touches states only the resulting truth. RFCs (`docs/rfc/`, grouped into `proposed/` / `implemented/` / `rejected/`) record the *why* behind choices a future reader would otherwise re-litigate (the vendoring policy, event-sourcing, the schema DSL are the existing examples). A PR that introduces such a decision — a new third-party runtime dependency over the vendoring default, a cross-package contract, a security/isolation model, a deviation from a documented architecture rule — writes the RFC in `implemented/` **in the same PR**, and links it from the relevant code. A proposal for future work not yet built goes in `proposed/`. A PR whose changes are mechanical, self-evident, or already covered by an existing RFC needs none — do not manufacture an RFC for a routine change. When unsure, the test is: would a competent maintainer six months from now ask "why was it done this way?" and be unable to answer from the code alone? If yes, write it. See [docs/rfc/README.md](docs/rfc/README.md) for the naming scheme and [docs/AGENTS.md](docs/AGENTS.md) for the cross-link convention.

**Markdown is not hard-wrapped**: write one line per paragraph and let the editor soft-wrap. Hard line breaks mid-paragraph make docs harder to edit and diff — a one-word change reflows and re-diffs the whole paragraph. This applies to prose only: leave fenced code blocks, tables, and list structure intact (a wrapped list item folds to one line per bullet). Code comments / JSDoc are exempt — they stay under the linter's column limit. `pnpm run verify-md-wrap` (part of `doc-sync`) enforces this across `README.md`, `docs/**/*.md`, `packages/*/*.md`, and `AGENTS.md` / `packages/AGENTS.md`; `pnpm run verify-md-links` (also part of `doc-sync`) checks that every relative cross-link in those files plus `examples/**/*.md` and `.agents/skills/**/*.md` resolves.

**Editing these instructions**: `AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it (at the repo root and in `packages/` / `examples/`). Always edit `AGENTS.md` — never write through the `CLAUDE.md` symlink or replace it with a regular file.

## Vendoring Policy

`vendor/` packages are pinned source copies (manifest with upstream commit SHAs in [vendor/README.md](vendor/README.md)). To update one, follow the sync procedure there; re-apply (or retire) the logged local modifications and rerun `pnpm run test && pnpm run build`.
