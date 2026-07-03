# RFC: Filesystem capability seam — ctx.fs, local backend, and model-facing filesystem tools

Status: implemented

## Problem

The harness has a concrete `bash` capability seam (`dsh-bash` / `dsh-bash-local` / `dsh-tool-bash`), but filesystem operations are about to be added as model-facing tools without an equivalent seam. If `read`, `write`, and `edit` directly use `node:fs`, the model-facing tool package will own filesystem execution policy, local path resolution, atomic write behavior, text decoding, symlink behavior, and edit semantics all at once.

That couples three concerns that change independently:

1. The filesystem contract: what operations plugins can ask for.
2. The backend: local disk now, sandboxed/remote/project-scoped filesystem later.
3. The consumer surface: model-facing `read` / `write` / `edit` schemas and result formatting.

Without a `ctx.fs` interface, swapping local filesystem access for a sandboxed or remote backend would churn the tool schemas, demos, and prompt guidance even when the model-facing contract should stay stable. It also makes permission/sandbox boundaries harder to reason about: a `cwd` option can look like a sandbox even though it is only a base path unless an explicit backend or `tools/execute` policy enforces containment.

We need the filesystem tools to land in the same capability-seam shape as bash before they become a public package surface.

## Proposal

Introduce filesystem access as a first-class capability seam following [the capability-seam RFC](../../implemented/architecture/2026-06-13-capability-seams.md):

1. `@deepseek-ai/dsh-fs` (`packages/fs/fs`) owns the abstract `ctx.fs` service, the filesystem vocabulary types, and the `fs/*` policy event vocabulary.
2. `@deepseek-ai/dsh-fs-local` (`packages/fs/fs-local`) provides the first implementation, backed by the local filesystem.
3. `@deepseek-ai/dsh-tool-fs` (`packages/fs/tool-fs`) provides the model-facing `read`, `write`, and `edit` tools over `ctx.fs`, and is the executor that dispatches the `fs/*` events.

The consumer package depends only on the interface package, never on `dsh-fs-local`. A deployment that wants a different backend loads a different provider for `ctx.fs` without changing the tool schemas or model-facing prompt guidance.

The read-before-write/edit and observed-state policy is a fourth package, `@deepseek-ai/dsh-fs-policy` (`packages/fs/fs-policy`), contributed through the `fs/*` event gate rather than living on `ctx.fs`. This RFC established the three-package seam; the split of policy off the provider base class is decided by [the split-fs-seam RFC](../simplification/2026-06-26-fsspec-style-fs-seam.md), and its realization as an event-gate plugin (not a method service) by [the event-gate RFC](2026-06-26-file-context-as-event-gate.md). This document is updated to describe that landed four-package shape.

The first backend is deliberately local-only: `dsh-fs-local` implements `ctx.fs` against the host filesystem. Future sibling backends can provide sandboxed, remote, virtual, or project-scoped filesystems behind the same interface.

The first consumer is deliberately text-file-only: `dsh-tool-fs` exposes model-facing `read`, `write`, and `edit` tools for UTF-8 text files. Future consumers can add directory listing, search/glob, binary-safe operations, file watching, or higher-level project operations without changing the local backend package, as long as the needed capability exists on `ctx.fs`. Direct directory listing was later added by [Add direct directory listing to the filesystem seam](2026-07-03-filesystem-directory-listing-seam.md).

Filesystem permissions and sandboxing are not implied by this split. The local backend resolves relative paths from its configured base directory, but containment policy is a separate decision: either a stricter `ctx.fs` implementation enforces it, or a permission/sandbox plugin wraps `tools/execute` and vetoes calls before they reach the consumer.

Read-before-write/edit and observed-state are policy, contributed by the `dsh-fs-policy` plugin through the `fs/*` event gate — NOT stored on `ctx.fs`. The provider seam offers an optional version guard on its mutations (`writeText`/`editText` take an optional expectation); the policy plugin decides that guard by listening on `fs/write-intent`/`fs/edit-intent` and records observed versions on `fs/observed`. The executor (`dsh-tool-fs`) passes the current tool execution context as the opaque event actor; the policy plugin derives the observed-state owner from it, normally `exec.agent.session`. `dsh-fs` treats the actor as opaque and never reads it; `dsh-tool-fs` never reaches into the policy plugin. Authorization is version freshness: any read records the file's version, and a later write/edit is authorized as long as the file is unchanged. (This RFC first placed the observed-state store on `ctx.fs`; the split to `dsh-fs-policy` on the `fs/*` event gate is decided by [the split-fs-seam](../simplification/2026-06-26-fsspec-style-fs-seam.md) and [event-gate](2026-06-26-file-context-as-event-gate.md) RFCs.)

## Package topology

The filesystem seam uses the same dependency direction as the bash trio:

```text
@deepseek-ai/dsh-tool-fs  --depends on-->  @deepseek-ai/dsh-fs  <--depends on--  @deepseek-ai/dsh-fs-local
        consumer                                interface                         implementation
```

`@deepseek-ai/dsh-fs` depends only on `cordis` plus the repo-wide `HarnessError` base from `@deepseek-ai/dsh-llm`. It declares the `ctx.fs` key, the abstract `FileSystem` service, the vocabulary types shared by backends and consumers, the filesystem error vocabulary, and the `fs/*` policy event vocabulary. It carries no observed-state store and no owner-derivation shape; the events pass an opaque `object` actor that the provider never reads, and the `dsh-fs-policy` plugin owns the owner-derivation shape and the observed-state store on top of those events.

`@deepseek-ai/dsh-fs-local` depends on `@deepseek-ai/dsh-fs` and `cordis`. It subclasses `FileSystem`, registers itself as `ctx.fs`, owns local-backend configuration such as the base directory, and contains all direct `node:fs` / `node:path` access. It holds no observed-state store — freshness is a version token the backend mints and the policy plugin records.

`@deepseek-ai/dsh-tool-fs` depends on `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, and `cordis`. It registers model-facing tools and prompt sections. It must not import `node:fs`, `node:path`, or `@deepseek-ai/dsh-fs-local`; filesystem execution always goes through `ctx.fs`. If the implementation needs concrete agent or session helper types, those dependencies belong in `tool-fs`; they must not leak back into `dsh-fs`.

The root `tool-fs` plugin registers the full filesystem tool suite (`read`, `write`, and `edit`) by composing the per-tool registration helpers. It injects `fs` and never imports an implementation package.

## `ctx.fs` contract

`@deepseek-ai/dsh-fs` owns a semantic filesystem service. It is higher-level than `readFile` / `writeFile` so `tool-fs` does not reimplement path resolution, versioning, text decoding, binary rejection, pagination, atomic replacement, symlink behavior, or literal edit semantics.

The exact TypeScript signatures are implementation details for the PR, but the interface must cover four semantic operations:

- Resolve a model/plugin-supplied path into a backend-defined target.
- Stat target metadata without reading file contents.
- Read a bounded UTF-8 text page from a target.
- Create or replace a UTF-8 text file.
- Edit an existing UTF-8 text file by literal replacement.

The provider seam also carries the freshness hooks that policy builds on — but the observed-state store and owner derivation live in the `dsh-fs-policy` plugin, not on `ctx.fs`:

- The backend mints an opaque `version` token per target (in `stat` and in every read/mutation outcome).
- `writeText`/`editText` take an OPTIONAL version expectation: omit it for an unconditional bare-provider mutation, or supply it to guard the mutation inside the backend's atomic critical section.
- The `dsh-fs-policy` plugin decides that expectation on `fs/write-intent`/`fs/edit-intent` and records observed versions on `fs/observed`, keyed by an owner it derives from the opaque event actor (normally `exec.agent.session`).

Authorization is version freshness, not a full/partial view distinction: any read records the target's version, and a later write/edit is authorized as long as the file is still at that version — so a windowed read of lines 100-150 authorizes an edit of line 120. The observed-state store is a `WeakMap<owner, Map<targetKey, version>>` inside `dsh-fs-policy`; `dsh-fs` holds none of it and treats the actor as opaque. (This RFC first modeled a `FileState` cache with `full`/`partial` views on `ctx.fs`; the split-fs-seam and event-gate RFCs replaced that with the freshness-based policy plugin described here.)

Path resolution should be explicit and allowed to be async. Local resolution may only normalize a path, but sandboxed/remote/project-scoped backends may need I/O to resolve a user-supplied path into a stable target identity.

Resolved targets must expose at least three concepts:

- The original input path, for diagnostics.
- An opaque `targetKey`, used for stale guards and file-state lookup. The local backend might use a realpath-like key; a remote backend might use a workspace URI or file id. Consumers must not parse or assume this is a local absolute path.
- A `displayPath`, used for model/UI-facing output. It may be a local absolute path, workspace-relative path, or remote URI depending on the backend.

Read and mutation results must include an opaque file `version`. A local backend can use mtime/size or a hash-like token; a remote backend can use a revision id. `ctx.fs` records versions in its file-state store for stale checks; consumers may display related metadata but must not interpret the version token.

The provider hands back decoded text: `readText` returns a whole regular text file, `streamText` streams the same text semantics for large files. Both own regular-file checks, bounded line/output handling is NOT theirs — line windowing, numbered-line rendering, and total-line accounting live in the executor (`dsh-tool-fs`), which reads through `ctx.fs` and renders the model-facing window. The provider owns UTF-8 decoding and binary/NUL rejection; it does not know about line windows or views.

Observed-state recording is not on `ctx.fs`: after a successful read the executor emits `fs/observed`, and the `dsh-fs-policy` plugin records `{ version }` for the deriving owner. There is no `full`/`partial` view — a read at any window records the version, and freshness (not view completeness) authorizes a later write/edit.

Full-file writes create or replace UTF-8 text files. Backends may create parent directories when that behavior is supported and documented. Existing non-regular targets are rejected. `writeText` takes an optional expectation: `createIfAbsent` creates a missing target and rejects an existing one with `FS_NOT_OBSERVED` (the path the policy uses for an unobserved owner); `replaceIfVersion` replaces only when the target exists at the observed version, else `FS_STALE_VERSION`; omitting the expectation is the unconditional bare-provider create-or-overwrite. The policy plugin chooses which expectation to supply from the owner's observed state.

Literal edit is a provider primitive (`editText`), not composed in `tool-fs` from a read plus write. Literal matching, duplicate-match rejection, CRLF preservation, binary rejection, optional stale-version checking, and atomic read-modify-write must stay together inside the backend's mutation critical section. `editText` takes the same optional version expectation; the stale check runs before literal matching so an edit against an old read reports `FS_STALE_VERSION`. A remote backend may implement edit as a native compare-and-edit operation; the consumer should not force local-style composition.

The policy plugin, not `ctx.fs`, gates on prior observation: an `edit` requires a prior observation by the owner (else `FS_NOT_OBSERVED`), and the recorded version is passed to `editText` as the CAS basis. With the policy plugin absent, `ctx.fs` alone is a complete unconstrained seam (unconditional write/edit); the tool is never method-coupled to the policy.

Filesystem contract failures are thrown as `FsError extends HarnessError`, and the tool registry converts them into `isError` tool results with structured `{ name, code }` metadata. `dsh-fs` owns this vocabulary rather than each tool inventing messages. The codes are `FS_NOT_FOUND`, `FS_NOT_TEXT`, `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_NOT_REGULAR_FILE`, `FS_AMBIGUOUS_EDIT`, `FS_EDIT_NOT_FOUND`, and `FS_ABORTED`. (An earlier draft included `FS_PARTIAL_OBSERVATION`; freshness-based authorization has no partial/full distinction, so it was dropped. Directory-listing-specific codes were added later by [Add direct directory listing to the filesystem seam](2026-07-03-filesystem-directory-listing-seam.md).)

## Tool consumer behavior

`@deepseek-ai/dsh-tool-fs` is the model-facing consumer. It owns tool names, JSON schemas, argument validation at the model boundary, prompt sections, and result formatting. It does not own filesystem execution.

The first tool suite contains:

- `read`: inspect a UTF-8 text file and return line-numbered content with pagination guidance.
- `write`: create or fully replace a UTF-8 text file.
- `edit`: update an existing UTF-8 text file by replacing literal text, requiring a unique match by default and allowing an explicit replace-all mode.

Each tool follows the same execution shape:

1. Validate and normalize model arguments.
2. Call the appropriate `ctx.fs` operation.
3. Format the result as `ContentBlock[]` for the model.
4. Let thrown backend/tool errors flow through `ToolRegistry.execute()`, which converts them into `isError` tool results.

The package registers prompt guidance through `ctx.systemPrompt.section(...)` and registers schemas through `ctx.tools.register(...)`. Tool schemas still flow into the normal prompt assembly path via `SystemPrompt.assemble()` and `ToolRegistry.schemas()`; no agent-loop changes are required.

The tool package must keep model-facing contracts stable when backends change. A local backend and a remote backend may resolve paths differently internally, but the `read` / `write` / `edit` schemas should not change solely because the backend changes.

The default deployment requires a prior `read` before updating an existing file with `write` or `edit`. `tool-fs` does not implement this by checking whether a tool named `read` ran: it dispatches the `fs/write-intent`/`fs/edit-intent` events (passing the execution context as the opaque actor), and the `dsh-fs-policy` plugin derives the owner, gates on prior observation, and supplies the version expectation. Any windowed read authorizes a later write/edit as long as the file is unchanged. Creating a new file with `write` does not require prior observation.

The root plugin registers the full suite by composing the per-tool registration helpers. It injects `fs`, `tools`, and `systemPrompt`.

## Migration plan

This RFC starts from `origin/master`, where no filesystem tool package exists yet. The landed implementation adds the new three-package topology directly:

1. Add `packages/fs/fs` with the `ctx.fs` abstract service and vocabulary types.
2. Add `packages/fs/fs-local` with the local backend implementation and backend-level tests.
3. Add `packages/fs/tool-fs` with the model-facing `read`, `write`, and `edit` tools over `ctx.fs`.
4. Update `docs/architecture.md`, `packages/README.md`, package READMEs, build/typecheck config, and aggregate maintenance scripts such as `scripts/publint-all.ts`.

This RFC's first landing kept the observed-state store behind `ctx.fs`. The split-fs-seam and event-gate RFCs then moved it into the standalone `@deepseek-ai/dsh-fs-policy` plugin on the `fs/*` event gate, which is the shipped shape; a deployment loading `dsh-tool-fs` also loads `dsh-fs-policy` to get read-before-write/edit.

Example leaf configs stay bash-only in this landing. Wiring `examples/coding-agent` or `examples/acp-agent` to `dsh-fs-local` + `dsh-tool-fs` changes the model prompt, visible tool schemas, and ACP snapshot transcript, so it should land as a follow-up UX/example change with prompt and snapshot updates in the same PR.

If this work is split into multiple PRs, they should follow the seam order:

1. Interface PR: `dsh-fs` only, with service registration and contract tests.
2. Implementation PR: `dsh-fs-local`, with real filesystem behavior tests.
3. Consumer PR: `dsh-tool-fs`, docs, and integration tests; example wiring follows in a separate prompt/snapshot PR.

The earlier combined package name `@deepseek-ai/dsh-fs-tools` should not become part of the new public surface.

## Tests

Tests should follow the package boundary, not only the user-visible tools.

`dsh-fs` tests cover the service seam itself: a provider registers `ctx.fs`, duplicate providers follow Cordis service behavior, disposal removes the service, and any shared contract helpers or type-level utilities behave as documented.

`dsh-fs-local` tests cover real filesystem behavior through the `ctx.fs` interface, not through model tools. They should include path resolution, absolute paths, `..` segments, symlinks inside and outside the configured base directory, reading small and large text files, streaming, binary-file rejection, invalid-UTF-8 rejection, abort handling, unconditional and version-guarded full-file writes, `createIfAbsent`/`replaceIfVersion` semantics, parent-directory creation, non-regular target rejection, literal edit success/failure, unique-match enforcement, replace-all behavior, line-ending preservation, stale-version rejection (guarded edit against an old version), and structured `FsError` codes. The observed-state/owner-derivation policy is NOT here — it lives in `dsh-fs-policy` and is tested there.

Beyond the happy/sad paths above, `dsh-fs-local` tests must cover the defensive-pattern classes this repo has been bitten by:

- **Atomic-write temp-file safety**, not just cleanup. The atomic replace must write its temp file into a private (`0700`) directory, with a random name and an exclusive owner-only (`'wx'`, `0o600`) open, mirroring the bash spill-file rules — predictable world-readable temp paths invite symlink races and disclosure. Assert the temp file's permissions and that a pre-existing temp path does not get clobbered, alongside the existing cleanup-on-failure path.
- **Implementation requirement:** `dsh-fs-local` write/edit use the same private-temp primitive: a random `0700` staging directory next to the target, an exclusive `0o600` temp file, cleanup on failure, and a final atomic rename. Do not move this RFC to `implemented/` if that primitive regresses or is deliberately revised.
- **`targetKey` identity through symlinks.** Two different input paths that resolve to the same realpath must share one file-state entry: a `read` via path A must satisfy the read-before-edit guard for an `edit` via symlink path B, and a stale write through one path must be detected through the other. This is the contract that makes the stale guard correct, so test it directly.
- **Concurrency / stale races.** The RFC names edit as race-prone (see Risks). Test that two concurrent write/edit operations against the same target settle deterministically: one succeeds and the other is rejected with `FS_STALE_VERSION` rather than silently overwriting, and that a successful edit refreshes recorded state so an immediately-following edit by the same owner proceeds.
- **HMR safety and disposal.** `dsh-fs-local` registers `ctx.fs` and owns the in-memory file-state store, so it needs its own HMR-safety test (register the backend on a fiber, dispose it, assert the `ctx.fs` provider is withdrawn and the file-state store is released — a later provider starts with no inherited state).

`dsh-tool-fs` tests cover the consumer surface against the real `dsh-fs-local` provider (mock only the model/clock, not the collaborator). They should verify tool schemas, argument validation, prompt-section registration, formatting of successful results, propagation of backend `FsError` codes into `isError` tool results through `ctx.tools.execute()`, that read/write/edit dispatch the `fs/*` events (passing the execution context as the actor), root-plugin suite registration, and HMR cleanup of both tool schemas and prompt sections.

Integration tests should load `dsh-fs-local` plus `dsh-tool-fs` (and, for the default deployment, `dsh-fs-policy`) and execute `read`, `write`, and `edit` through `ctx.tools.execute()` to prove the packages work together without bypassing the tool registry — including a bare-provider path (no `dsh-fs-policy`) where an unread edit/overwrite succeeds. They must verify the world, not the tool's self-report: after a `write`/`edit`, read the file back from disk and assert byte-identical content (and that untouched files are unchanged), rather than trusting the returned `ContentBlock[]`. Each integration/e2e test owns its resources — create the harness in the test, run against a per-test temporary directory, and dispose the harness and remove the directory in `afterEach` even on failure or timeout.

Repo gates for the implementation include the focused vitest suites, `pnpm run typecheck`, `pnpm run test:coverage` for runtime code, and build/publint coverage after adding package entrypoints.

## Risks

**`cwd` can be mistaken for a sandbox.** The local backend's base directory is a resolution default, not automatically a containment boundary. If containment is required, it must be enforced by the backend contract or by a permission/sandbox plugin on `tools/execute`.

**The interface can become too local.** Returning fields such as `absolutePath` from `ctx.fs` would make remote, sandboxed, or virtual backends awkward. The contract should expose display metadata without requiring consumers to understand host paths.

**The interface can become too thin.** If `ctx.fs` only mirrors `node:fs` primitives, `tool-fs` will reimplement binary detection, pagination, atomic writes, and edit semantics. That recreates the coupling this RFC is trying to avoid.

**Edit semantics are race-prone.** Literal edit is a read-modify-write operation. Without a stale-content guard or backend-level atomic edit primitive, concurrent edits can overwrite each other. The first implementation should document its guarantees clearly; stronger compare-and-swap semantics can be added later if needed.

**Observed state does not belong on `ctx.fs`.** Recording what an execution context has seen is workflow policy, not raw filesystem I/O. This RFC first placed it inside the filesystem seam; the split-fs-seam RFC then established that a sandboxed/remote backend should not inherit model-facing observation policy, and moved it into the `dsh-fs-policy` plugin. The provider seam keeps only what write/edit safety genuinely needs at the storage layer — a backend-minted version token and an optional version-guarded mutation — while the policy plugin owns owner derivation, observed-state, and read-before-edit gating over the `fs/*` events.

**The `resolve`-then-operate shape costs an extra round-trip per call.** Each tool may resolve a path to an `FsTarget` and then issue the read/write/edit as a separate `ctx.fs` call. For the local backend this is negligible (resolution is in-memory path normalization), but a remote/sandboxed backend may turn each step into its own request, so a single `read` can become two network round-trips. Backends where the round-trip matters can cache or fold resolution internally while preserving the observable contract.

**File-state persistence is deferred.** The first implementation can keep file state in memory. Resumed sessions should conservatively require files to be read again before write/edit tools accept updates until a future session-event or persistence mechanism makes file state replayable.

**Error codes become part of the seam.** `FsError` codes make stale-version and observation failures machine-routable through the existing structured error taxonomy. The cost is that `dsh-fs` imports the shared `HarnessError` base from `dsh-llm`; that dependency is intentional and should stay limited to the error vocabulary.

**Package churn is front-loaded.** The three-package split adds boilerplate before there is more than one backend. This is intentional: filesystem access is a likely sandbox/remote boundary, and changing the package surface after shipping model-facing tools would be more expensive.
