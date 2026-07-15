# AGENTS.md

DeepSeek Harness SDK is a plugin-based agent harness on vendored Cordis: **everything is a plugin**. Read [docs/architecture.md](docs/architecture.md) before changing `packages/`; follow [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Pre-release stance: foundation over blast radius

**Remove this section at the first tagged release.** With no external consumers, prefer the correct foundation over compatibility shims: rename or repackage freely and update every reference together. Backends reject old on-disk formats. SQLite uses monotonic `SCHEMA_VERSION`; `dsh-session` keeps `SESSION_FORMAT_VERSION` at `0` with no compatibility promise.

## Repository layout

```
vendor/      Vendored Cordis source — manifest + sync procedure in vendor/README.md
packages/    Harness packages at packages/<group>/<pkg>/, all named @deepseek-ai/dsh-<pkg>
  core/        product API spine: session, system-prompt, tools, agent, agent-loop
  llm/         LLM seam + the DeepSeek adapters (hand-rolled + pi-ai design twin)
  bash/        bash executor seam + local impl + model-facing bash tools
  fs/          filesystem seam + local impl + policy gate + read/write/edit tools
  skill/       skill provider registry + local impl + catalog/loader tool
  web/         web seam + search/fetch providers + model-facing web tools
  compact/     compaction seam + basic backend
  context/     request-context plugins
  subagent/    subagent seam + spawn/fork/ACP backends + delegation tool
  workflow/    workflow seam + worker-thread engine + the workflow tool
  todo/        the todo_write tool
  guard/       loop-hygiene plugins
  cordis/      self-referential toolset: the agent inspects/mounts plugins in its own runtime
  hooks/       Claude Code / Codex hook bridges + shared wire-protocol library
  session-persistence/  persistence seam + JSONL/SQLite backends
  ui/          ACP/stdio/JSON-RPC bridges; boot, approval, interaction plugins
  examples/    demo bundles (agent-spine + stdio/ACP/JSON-RPC bins) leaves load
  support/     dev/test infrastructure packages
  util/        zero-dependency utilities
python/      Python SDK and bundled runtime (see python/README.md)
examples/    Runnable cordis.yml leaves over packages/examples bundles (see examples/AGENTS.md)
docs/        architecture, generated catalogs, RFCs, postmortems, cookbook (see docs/AGENTS.md)
scripts/     repo gates and generators
```

Package groups: [packages/README.md](packages/README.md).

## Commands

```sh
pnpm install            # pnpm workspaces, node ^22.19 || >=24
pnpm run test           # vitest unit tests
pnpm run test:coverage  # THE gating test run: per-file 100% coverage on packages/*/*/src
pnpm run test:e2e       # real-API tests; self-skip without DEEPSEEK_API_KEY
pnpm run test:snapshot  # keyless ACP replay vs goldens; filter: -t <name>
pnpm run test:snapshot:record  # re-record goldens (needs key)
pnpm run typecheck
pnpm run lint
pnpm run duplication    # cross-file TypeScript clone detection
pnpm run build          # tsc emits lib/types, tsdown bundles runtime
pnpm run hygiene        # knip + publint + workspace constraints + NodeNext consumer check
pnpm run doc-sync       # all documentation gates; see the doc-sync script in package.json
pnpm run demo:echo      # mock-model REPL, no key needed
pnpm run demo:repl      # real REPL coding agent (needs DEEPSEEK_API_KEY)
pnpm run demo:cordis    # self-referential demo: the agent modifies its own runtime (needs key)
pnpm run demo:acp       # ACP server agent (needs DEEPSEEK_API_KEY)
```

### Run the CI gates locally before marking a PR ready

Run narrow checks during implementation and this CI-equivalent sequence before marking a PR ready. Fresh worktrees need `pnpm run build` before publint and NodeNext inspect `lib/`:

```sh
set -euo pipefail
pnpm run typecheck
pnpm run lint
pnpm run duplication
pnpm run test:coverage
pnpm run test:snapshot
pnpm run doc-sync
pnpm run verify-module-graph
pnpm run build
pnpm run hygiene
out=$(printf 'echo ci smoke\n' | pnpm run demo:echo 2>&1)
printf '%s\n' "$out" | grep -q '\[tool call\] echo({"text":"ci smoke"})'
printf '%s\n' "$out" | grep -q '\[tool result\] ECHO: CI SMOKE'
test -n "$(find .sessions -path '.sessions/cwd-*/main-session-*.jsonl' -type f -print -quit)"
rm -rf .sessions
pnpm exec vitest run --config vitest.e2e.config.ts packages/examples/stdio-demo/tests/built-bin.e2e.ts packages/examples/acp-demo/tests/built-bin.e2e.ts packages/workflow/workflow-workerthread/tests/built-worker.e2e.ts packages/code-runtime/code-runtime-worker/tests/built-lib.e2e.ts
```

`test:coverage`, not `test`, is the gate ([why](docs/testing.md)); report only commands actually run.

## Secrets / .env

Real-API tests and demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and root `.env`. cordis.yml allows `!!js` (never `!js`) only under plugin `config`; Loader metadata is static, so conditional composition uses overlays ([primer](docs/cordis-primer.md#loader-configuration)). Never commit credentials. CI e2e skips without a key; [testing.md](docs/testing.md) owns key policy.

## Conventions

- Every npm package is `@deepseek-ai/dsh-<name>`; vendored packages keep upstream names and are `private: true`. `cordis` is a peerDependency (+ dev) of every harness package.
- ESM everywhere (`"type": "module"`). Cross-package imports use package names, never relative paths; in-package relative imports use explicit `.ts` extensions. Dev/test/demo run unbuilt via tsx + the root tsconfig `paths` map; builds are for outside consumers only.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
- **Typed events use declaration merging** and merge-extensible maps. Event JSDoc needs `@mode` and payload `@param`; scoped keys absent from payloads need `@dshScopeScan unsupported`. Public service methods document parameters and non-void returns.
- **Switch on discriminant tags.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it is the veto ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Plugins, not loop changes**: new behavior goes on the documented extension seams; changing `agent-loop` requires updating docs/architecture.md.
- **Capability seams are three packages** — interface / implementation / consumer; don't split preemptively.
- **Explicit > implicit at package seams**: defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()` (the `dsh-bash` request/spec split is the template).
- **No hardcoded tunables in plugins**: deployment choices are defaulted, validated `Config` fields changeable from cordis.yml; a `DEFAULT_*` constant or test seam is not configurability. Protocol constants, external specs, and security invariants stay fixed.
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **An empty `catch` names what it swallows** and why nothing else can reach it; keep the `try` to one statement.
- **Prefer symmetry for parallel values**; unexplained asymmetry usually signals a missed extraction.
- **Tests describe behavior, not correctness.** Change obsolete behavior with its tests; explain why in the PR.
- **Validate RFC premises against current code**; friction may expose overreach, so amend proposals before moving them to `implemented/`.
- **Testing policy** — [docs/testing.md](docs/testing.md). Transcript changes need snapshots or a PR note. Fixtures must replay on macOS/Linux; fix fixtures, not normalizers.
- **A tool's ACP render intent is part of its design**, decided up front (`generic`/`terminal`/`diff`, `locations`); presentation methods are pure functions of `args` ([cookbook](docs/cookbook/adding-a-tool.md)).
- **Plan unit, e2e, and snapshot coverage** for new seams, lifecycle shapes, and transcript surfaces, and schedule any missing harness support before implementation.
- **Merge PRs with merge commits**, never squash/rebase or rewrite pushed branches. Put a review fix on its introducing PR, then merge down the stack ([guide](docs/cookbook/responding-to-pr-review-on-a-stack.md)).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --check` (pre-push) gates it.

## Defensive patterns

Read [docs/defensive-patterns.md](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work.

## Type safety and documentation

Everything compiles under `strict: true` with `noImplicitAny`; every remaining `any` explains why a narrower type is infeasible. Every module and export has concise JSDoc for its non-obvious contract; function-like exports include `@param`/`@returns`, as enforced by `verify-export-jsdoc`. Heritage-declared members, plugin-protocol slots, and constructors keep their docs at the declaring seam, protocol, or class.

Comments and docs preserve complete contracts and non-obvious orientation, not reasoning transcripts. Do not narrate control flow or tests, preserve review history, or restate code. Keep factual clauses affecting behavior, failure, timing, ownership, or safe use; link aggressively to owning rationale. Use [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md) for prose decisions. Encode enforceable invariants in checks, using narrow justified exceptions rather than disabling a rule globally.

Docs are part of every change: code changes update their README and JSDoc in the SAME change; a bilingual-pair edit updates the counterpart and re-records ([i18n contract](docs/i18n/README.md)). The writing rules — document the current state never the history, one physical line per paragraph, one home per fact — and the word-budget gate live in [docs/AGENTS.md](docs/AGENTS.md).

## Editing these instructions

`CLAUDE.md` symlinks `AGENTS.md` at root, `packages/`, and `examples/`; edit the real file. Keep each rule self-contained while linking high-level docs. Condense when clarity survives; raise a `verify-doc-budgets` ceiling when the contract genuinely needs more space.

## Vendoring policy

`vendor/` packages are pinned source copies (manifest with upstream SHAs in [vendor/README.md](vendor/README.md)). Update via the sync procedure there; re-apply or retire the logged local modifications; rerun `pnpm run test && pnpm run build`.
