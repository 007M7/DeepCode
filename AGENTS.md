# AGENTS.md

This is the monorepo of the DeepSeek Harness group; it hosts **DeepSeek Harness SDK**, a plugin-based SDK for building agent harnesses. The codebase is built on the vendored Cordis framework, microkernel-style: **everything is a plugin**. Read [docs/architecture.md](docs/architecture.md) before changing `packages/`; the documentation standard is [docs/AGENTS.md](docs/AGENTS.md).

## Pre-release stance: foundation over blast radius

**This applies only while the harness is unreleased — remove this section at the first tagged release.** There are no external consumers, so optimize for the correct foundation, not a small diff: move files, rename public symbols, repackage plugins, and update every reference in the same change. No backward-compat shims, deprecation aliases, or re-export stubs. On-disk formats need no migrations — a backend REJECTS anything not at the current version. Two sanctioned version stances: monotonic bump-and-reject (the SQLite backend's `SCHEMA_VERSION`), and a pinned `0` that absorbs all shape churn (`SESSION_FORMAT_VERSION` in `dsh-session`, documented "no compatibility implied"). Real version policy begins at the first release.

## Repository layout

```
vendor/      Vendored Cordis source — manifest + sync procedure in vendor/README.md
packages/    Harness packages at packages/<group>/<pkg>/, all named @deepseek-ai/dsh-<pkg>
  core/        product API spine: session, system-prompt, tools, agent, agent-loop, agent-core (the bundle)
  llm/         LLM seam + the DeepSeek adapters (hand-rolled + pi-ai design twin)
  bash/        bash executor seam + local impl + model-facing bash tools
  fs/          filesystem seam + local impl + policy gate + read/write/edit tools
  web/         web seam + search/fetch providers + model-facing web tools
  compact/     compaction seam + basic backend
  subagent/    subagent seam + spawn/fork/ACP backends + delegation tool
  todo/        the todo_write tool
  guard/       loop-hygiene plugins
  hooks/       Claude Code / Codex hook bridges + shared wire-protocol library
  session-persistence/  persistence seam + JSONL/SQLite backends
  ui/          ACP bridge + app-boot glue + the stdio/ACP app bins
  support/     dev/test infrastructure packages
  util/        zero-dependency utilities
examples/    Runnable demos: thin cordis.yml leaves over the app packages (see examples/AGENTS.md)
docs/        architecture, generated catalogs, RFCs, postmortems, cookbook (see docs/AGENTS.md)
scripts/     repo gates and generators
```

Per-package map: the group READMEs, indexed from [packages/README.md](packages/README.md).

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
pnpm run build          # tsc emits lib/types, tsdown bundles runtime
pnpm run hygiene        # knip + publint + workspace constraints + NodeNext consumer check
pnpm run doc-sync       # all documentation gates; see the doc-sync script in package.json
pnpm run demo:echo      # mock-model REPL, no key needed
pnpm run demo:repl      # real REPL coding agent (needs DEEPSEEK_API_KEY)
pnpm run demo:acp       # ACP server agent (needs DEEPSEEK_API_KEY)
```

### Run the CI gates locally before marking a PR ready

During implementation, run the narrowest affected checks; run this full CI-equivalent sequence only when complete and before marking a PR ready. From a fresh clone/worktree, `pnpm run build` first because publint and NodeNext validate built `lib/`:

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

`test:coverage`, not `test`, is the gating run ([why](docs/testing.md)); a sign-off counts only for commands actually run.

## Secrets / .env

Real-API tests and demos read `DEEPSEEK_API_KEY` (and optional `DEEPSEEK_BASE_URL`) from the environment or a gitignored root `.env` loaded via `process.loadEnvFile()`. cordis.yml references env vars with the `!!js` tag (never `!js`). Never commit credentials. CI has no secrets, so e2e suites self-skip without a key — a CI accommodation, not a cost signal; the with-key policy is in [docs/testing.md](docs/testing.md).

## Conventions

- Every npm package is `@deepseek-ai/dsh-<name>`; vendored packages keep upstream names and are `private: true`. `cordis` is a peerDependency (+ dev) of every harness package.
- ESM everywhere (`"type": "module"`). Cross-package imports use package names, never relative paths; in-package relative imports use explicit `.ts` extensions. Dev/test/demo run unbuilt via tsx + the root tsconfig `paths` map; builds are for outside consumers only.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
- **Typed events via declaration merging**; extensible unions use the merge-extensible-map pattern (`ContentBlockMap`, `SessionEventMap`, …). Every new event's JSDoc carries an `@mode` tag and a `@param` per payload parameter (`this`/trailing `next` exempt); every public service-class method documents each parameter and non-void return (`@param`/`@returns`) — the catalog generator hard-errors otherwise; mode semantics are in the [generated events catalog](docs/cordis-catalog/events.md) header.
- **Discriminated unions: `switch` on the tag**, not if-chains. Closed unions end with `default: assertNever(...)`; merge-extensible unions must NOT — handle known cases and fall through `default` with a comment.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it is the veto ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Plugins, not loop changes**: new behavior goes on the documented extension seams; changing `agent-loop` requires updating docs/architecture.md.
- **Capability seams are three packages** — interface / implementation / consumer; don't split preemptively.
- **Explicit > implicit at package seams**: defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()` (the `dsh-bash` request/spec split is the template).
- **No hardcoded tunables in plugins**: anything two deployments could want different — timeouts, caps, model names, base URLs — is a defaulted, validated `Config` field, not a literal; a `DEFAULT_*` constant or test-only seam is not configurability. The test: changeable from `cordis.yml`, no code edit. Protocol/wire constants, external-spec values, security invariants stay hardcoded.
- **Misconfiguration fails loud**: a config value referencing something that does not exist (a `toolOrder` tool name, a plugin path) throws — at load when the check is self-contained, else at the earliest moment the referent exists (for `toolOrder`, every prompt assembly) — never a silent skip.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **An empty `catch` names what it swallows** and why nothing else can reach it; keep the `try` to one statement.
- **Symmetry is usually more correct**: parallel values get parallel form; asymmetry smells of a missed extraction.
- **Tests document behavior, not golden truth**: a green test pins what the code DOES, not what it SHOULD do. Before preserving a behavior solely for its test, ask whether it is load-bearing; an artifact changes together with its test, with the why in the PR.
- **RFCs are proposals, not golden truth**: validate its premise against current code before implementing; friction is evidence of over-reach — amend on the way to `implemented/`.
- **Testing policy** — [docs/testing.md](docs/testing.md). Transcript/UX changes need snapshots or a PR note. Snapshot fixtures must replay on macOS/Linux; avoid GNU/BSD-only commands (e.g. `sed -i`); fix fixtures, not normalizers.
- **A tool's ACP render intent is part of its design**, decided up front (`generic`/`terminal`/`diff`, `locations`); presentation methods are pure functions of `args` ([cookbook](docs/cookbook/adding-a-tool.md)).
- **A new capability seam, lifecycle shape, or transcript surface names its coverage at every tier (unit, e2e, snapshot) at plan time** and verifies the harness can express it — a gap is scheduled work, not a mid-build surprise.
- **Merge PRs with merge commits** (`gh pr merge --merge`), never squash/rebase. **Never rewrite a pushed branch**; update a child by merging its parent down. **A review fix lands on the PR that introduced the issue, as a separate commit**, then merges down ([stacked-review guide](docs/cookbook/responding-to-pr-review-on-a-stack.md)).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --check` (pre-push) gates it.

## Defensive patterns

[docs/defensive-patterns.md](docs/defensive-patterns.md) carries the hard-won bug-class rules: report orthogonal outcomes independently; honor cross-seam contracts on both sides; async state is not synchronous state; dispose must reach quiescence; contain callback exceptions; never hand untrusted output the ambient environment or predictable paths. Read it before lifecycle, concurrency, subprocess, or teardown work.

## Type safety and documentation

Everything compiles under `strict: true` with `noImplicitAny`; every remaining `any` carries a comment saying why a narrower type is infeasible. Every module has a module-level doc comment; every export (and non-obvious method) has a JSDoc explaining semantics — contracts, disposal, errors — not the name restated; internal helpers only where non-obvious; one-liners when one line suffices. The export half is mechanical: `verify-export-jsdoc` (in `doc-sync`) requires description prose on every package export plus `@param`/`@returns` (and an annotated return) on function-like ones. Heritage-declared members, plugin-protocol slots, and constructors are exempt — their docs' one home is the seam declaration, the framework protocol, and the class doc respectively. Lean toward the stricter lint rule and the extra mechanical gate: encode invariants in checks (`verify-*` scripts), preferring a narrow justified escape hatch over a rule left off globally. Type gymnastics are acceptable inside core packages when they buy plugin-author DX (the `defineTool` schema DSL is the canonical example).

Docs are part of every change: code changes update their README and JSDoc in the SAME change; a bilingual-pair edit updates the counterpart and re-records ([i18n contract](docs/i18n/README.md)). The writing rules — document the current state never the history, one physical line per paragraph, one home per fact — and the word-budget gate live in [docs/AGENTS.md](docs/AGENTS.md).

## Editing these instructions

`AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it (root, `packages/`, `examples/`). Edit `AGENTS.md`, never the symlink. Keep it self-contained: state each principle inline instead of citing RFCs (they stay discoverable via the RFC index); linking high-level docs — architecture, testing, cookbooks — is fine. This file is budget-gated (`verify-doc-budgets`): condense first if it is possible without sacrificing clarity; truly needed additions may justify a ceiling raise.

## Vendoring policy

`vendor/` packages are pinned source copies (manifest with upstream SHAs in [vendor/README.md](vendor/README.md)). Update via the sync procedure there; re-apply or retire the logged local modifications; rerun `pnpm run test && pnpm run build`.
