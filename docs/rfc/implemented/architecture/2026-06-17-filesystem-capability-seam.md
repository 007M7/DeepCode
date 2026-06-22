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

1. `@deepseek-ai/dsh-fs` (`packages/fs/fs`) owns the abstract `ctx.fs` service, filesystem vocabulary types, and file-state tracking contract.
2. `@deepseek-ai/dsh-fs-local` (`packages/fs/fs-local`) provides the first implementation, backed by the local filesystem.
3. `@deepseek-ai/dsh-tool-fs` (`packages/fs/tool-fs`) provides the model-facing `read`, `write`, and `edit` tools over `ctx.fs`.

The consumer package depends only on the interface package, never on `dsh-fs-local`. A deployment that wants a different backend loads a different provider for `ctx.fs` without changing the tool schemas or model-facing prompt guidance.

The first backend is deliberately local-only: `dsh-fs-local` implements `ctx.fs` against the host filesystem. Future sibling backends can provide sandboxed, remote, virtual, or project-scoped filesystems behind the same interface.

The first consumer is deliberately text-file-only: `dsh-tool-fs` exposes model-facing `read`, `write`, and `edit` tools for UTF-8 text files. Future consumers can add directory listing, search/glob, binary-safe operations, file watching, or higher-level project operations without changing the local backend package, as long as the needed capability exists on `ctx.fs`.

Filesystem permissions and sandboxing are not implied by this split. The local backend resolves relative paths from its configured base directory, but containment policy is a separate decision: either a stricter `ctx.fs` implementation enforces it, or a permission/sandbox plugin wraps `tools/execute` and vetoes calls before they reach the consumer.

Read-before-write/edit is part of the filesystem seam, not a separate service. `ctx.fs` records which file states the current execution context has seen and validates write-like operations against that state. The first `tool-fs` consumer passes the current tool execution context, or a structural projection of it, through to `ctx.fs`; `ctx.fs` derives the file-state owner from that context, normally `exec.agent.session`. `tool-fs` does not know the cache shape, the owner key, or the `read` tool name/schema.

## Package topology

The filesystem seam uses the same dependency direction as the bash trio:

```text
@deepseek-ai/dsh-tool-fs  --depends on-->  @deepseek-ai/dsh-fs  <--depends on--  @deepseek-ai/dsh-fs-local
        consumer                                interface                         implementation
```

`@deepseek-ai/dsh-fs` depends only on `cordis` plus the repo-wide `HarnessError` base from `@deepseek-ai/dsh-llm`. It declares the `ctx.fs` key, the abstract `FileSystem` service, the vocabulary types shared by backends and consumers, the filesystem error vocabulary, and the file-state contract. The interface defines a minimal structural execution context shape rather than importing `dsh-tools`, `dsh-agent`, or `dsh-session`; the implementation derives a file-state owner from that shape when one is available. The owner object is opaque to `dsh-fs`: `tool-fs` may pass the `ToolExecution` it already receives, or a projected object containing only the owner-bearing fields, without making `dsh-fs` depend on the tool or agent packages.

`@deepseek-ai/dsh-fs-local` depends on `@deepseek-ai/dsh-fs` and `cordis`. It subclasses `FileSystem`, registers itself as `ctx.fs`, owns local-backend configuration such as the base directory, contains all direct `node:fs` / `node:path` access, and provides the in-memory file-state store for the local backend.

`@deepseek-ai/dsh-tool-fs` depends on `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, and `cordis`. It registers model-facing tools and prompt sections. It must not import `node:fs`, `node:path`, or `@deepseek-ai/dsh-fs-local`; filesystem execution always goes through `ctx.fs`. If the implementation needs concrete agent or session helper types, those dependencies belong in `tool-fs`; they must not leak back into `dsh-fs`.

The root `tool-fs` plugin registers the full filesystem tool suite by composing the per-tool registration helpers (`read`, `write`, and `edit`). The same helpers are exposed as subpath plugins such as `@deepseek-ai/dsh-tool-fs/read`, `@deepseek-ai/dsh-tool-fs/write`, and `@deepseek-ai/dsh-tool-fs/edit` for focused deployments. Root and subpath plugins follow the same rule: they inject `fs` and never import an implementation package.

## `ctx.fs` contract

`@deepseek-ai/dsh-fs` owns a semantic filesystem service. It is higher-level than `readFile` / `writeFile` so `tool-fs` does not reimplement path resolution, versioning, text decoding, binary rejection, pagination, atomic replacement, symlink behavior, or literal edit semantics.

The exact TypeScript signatures are implementation details for the PR, but the interface must cover four semantic operations:

- Resolve a model/plugin-supplied path into a backend-defined target.
- Read a bounded UTF-8 text page from a target.
- Create or replace a UTF-8 text file.
- Edit an existing UTF-8 text file by literal replacement.

The interface must also cover file state:

- Derive a file-state owner from the current execution context, normally the active agent session.
- Record that the owner saw a target at a backend-defined version.
- Determine whether that owner has a full editable view of a target.
- Use the recorded version as the stale guard for write/edit operations that require prior observation.
- Refresh the recorded state after a successful write/edit so follow-up modifications can proceed without forcing another read.

The in-memory shape is conceptually a weakly-owned cache: file state is keyed first by the derived owner object, then by the backend `targetKey`. The owner is usually `exec.agent.session`, but `dsh-fs` treats it as opaque and does not import `dsh-session`. Each cached `FileState` records the `targetKey`, `displayPath`, backend `version`, current view (`full` or `partial`), update time, and source (`read`, `write`, `edit`, or a future seed path). Only a `full` view authorizes write/edit. A `partial` view records useful context (paged read, truncated read, injected context) but does not grant edit authority.

Path resolution should be explicit and allowed to be async. Local resolution may only normalize a path, but sandboxed/remote/project-scoped backends may need I/O to resolve a user-supplied path into a stable target identity.

Resolved targets must expose at least three concepts:

- The original input path, for diagnostics.
- An opaque `targetKey`, used for stale guards and file-state lookup. The local backend might use a realpath-like key; a remote backend might use a workspace URI or file id. Consumers must not parse or assume this is a local absolute path.
- A `displayPath`, used for model/UI-facing output. It may be a local absolute path, workspace-relative path, or remote URI depending on the backend.

Read and mutation results must include an opaque file `version`. A local backend can use mtime/size or a hash-like token; a remote backend can use a revision id. `ctx.fs` records versions in its file-state store for stale checks; consumers may display related metadata but must not interpret the version token.

Text reads return structured UTF-8 line records or ranges with pagination metadata. `tool-fs` owns line-numbered model text rendering; the backend owns bounded line length, bounded output bytes, binary-file rejection, total-line accounting, and whether the returned content is a partial view of the file.

When a read has a file-state owner, `ctx.fs` records the target, version, display path, view metadata, timestamp, and source. Partial views are useful context but do not authorize write/edit unless a future operation can prove the model saw the raw editable content.

Full-file writes create or replace UTF-8 text files. Backends may create parent directories when that behavior is supported and documented. Existing non-regular targets are rejected. For updates to existing files, `ctx.fs` should require a full prior file state for the current owner and reject absent or partial state. The backend then compares the current file version to the recorded version and rejects stale writes. If the recorded target no longer exists, the write is stale rather than a create. A create is expressed as a write to a target with no existing file and does not require prior state or a file-state owner.

Literal edit is part of `ctx.fs`, not composed in `tool-fs` from a read plus write. Literal matching, duplicate-match rejection, CRLF preservation, binary rejection, prior-file-state checking, stale-version checking, and atomic read-modify-write are filesystem/backend semantics. A remote backend may implement edit as a native compare-and-edit operation; the consumer should not force local-style composition.

Direct tool executions without a derivable file-state owner can still exercise lower-level helpers in tests. Production `write`/`edit` tool calls should reject without an owner when they update an existing target, because those operations require prior state. Owner-less `write` may still create a new file when the backend confirms that the target does not already exist.

Filesystem contract failures are thrown as `FsError extends HarnessError` in the first implementation, and the tool registry converts them into `isError` tool results with structured `{ name, code }` metadata. `dsh-fs` owns this vocabulary rather than each tool inventing messages. Initial codes should include `FS_NOT_FOUND`, `FS_NOT_TEXT`, `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_PARTIAL_OBSERVATION`, `FS_NOT_REGULAR_FILE`, `FS_AMBIGUOUS_EDIT`, and `FS_EDIT_NOT_FOUND`.

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

The first implementation requires a prior full `read` before updating an existing file with `write` or `edit`. `tool-fs` does not implement this by checking whether a tool named `read` ran or by reading the file-state cache. It passes the current execution context to `ctx.fs`, and `ctx.fs` derives the file-state owner and enforces file-state/stale-version policy. Creating a new file with `write` does not require prior state or an owner.

The root plugin registers the full suite by composing the per-tool registration helpers. The subpath plugins register one tool each for focused deployments and tests. Both forms inject `fs`, `tools`, and `systemPrompt`.

## Migration plan

This RFC starts from `origin/master`, where no filesystem tool package exists yet. The final implementation should add the new three-package topology directly:

1. Add `packages/fs/fs` with the `ctx.fs` abstract service and vocabulary types.
2. Add `packages/fs/fs-local` with the local backend implementation and backend-level tests.
3. Add `packages/fs/tool-fs` with the model-facing `read`, `write`, and `edit` tools over `ctx.fs`.
4. Wire examples by loading a `ctx.fs` provider first (`dsh-fs-local`), then the consumer (`dsh-tool-fs` or one of its subpath plugins).
5. Update `docs/architecture.md`, `packages/README.md`, package READMEs, build/typecheck config, and aggregate maintenance scripts such as `scripts/publint-all.ts`.

This first pass does not add a separate `@deepseek-ai/dsh-file-context` package. The file-state store lives behind `ctx.fs` so root and subpath `tool-fs` plugins share the same read-before-write/edit policy automatically.

If this work is split into multiple PRs, they should follow the seam order:

1. Interface PR: `dsh-fs` only, with service registration and contract tests.
2. Implementation PR: `dsh-fs-local`, with real filesystem behavior tests.
3. Consumer PR: `dsh-tool-fs`, examples, docs, and integration tests.

The earlier combined package name `@deepseek-ai/dsh-fs-tools` should not become part of the new public surface.

## Tests

Tests should follow the package boundary, not only the user-visible tools.

`dsh-fs` tests cover the service seam itself: a provider registers `ctx.fs`, duplicate providers follow Cordis service behavior, disposal removes the service, and any shared contract helpers or type-level utilities behave as documented.

`dsh-fs-local` tests cover real filesystem behavior through the `ctx.fs` interface, not through model tools. They should include path resolution, absolute paths, `..` segments, symlinks inside and outside the configured base directory, reading small and large text files, pagination, output caps, binary-file rejection, abort handling, full-file create/update writes, owner-less creates, owner-less update rejection, parent-directory creation, non-regular target rejection, literal edit success/failure, unique-match enforcement, replace-all behavior, line-ending preservation, file-state recording after reads, session/owner isolation, read-before-update rejection, stale-version rejection, partial-view rejection, structured `FsError` codes, and file-state refresh after successful writes/edits.

Beyond the happy/sad paths above, `dsh-fs-local` tests must cover the defensive-pattern classes this repo has been bitten by:

- **Atomic-write temp-file safety**, not just cleanup. The atomic replace must write its temp file into a private (`0700`) directory, with a random name and an exclusive owner-only (`'wx'`, `0o600`) open, mirroring the bash spill-file rules — predictable world-readable temp paths invite symlink races and disclosure. Assert the temp file's permissions and that a pre-existing temp path does not get clobbered, alongside the existing cleanup-on-failure path.
- **Implementation requirement:** `dsh-fs-local` write/edit use the same private-temp primitive: a random `0700` staging directory next to the target, an exclusive `0o600` temp file, cleanup on failure, and a final atomic rename. Do not move this RFC to `implemented/` if that primitive regresses or is deliberately revised.
- **`targetKey` identity through symlinks.** Two different input paths that resolve to the same realpath must share one file-state entry: a `read` via path A must satisfy the read-before-edit guard for an `edit` via symlink path B, and a stale write through one path must be detected through the other. This is the contract that makes the stale guard correct, so test it directly.
- **Concurrency / stale races.** The RFC names edit as race-prone (see Risks). Test that two concurrent write/edit operations against the same target settle deterministically: one succeeds and the other is rejected with `FS_STALE_VERSION` rather than silently overwriting, and that a successful edit refreshes recorded state so an immediately-following edit by the same owner proceeds.
- **HMR safety and disposal.** `dsh-fs-local` registers `ctx.fs` and owns the in-memory file-state store, so it needs its own HMR-safety test (register the backend on a fiber, dispose it, assert the `ctx.fs` provider is withdrawn and the file-state store is released — a later provider starts with no inherited state).

`dsh-tool-fs` tests cover the consumer surface with a fake `ctx.fs` implementation. They should verify tool schemas, argument validation, prompt-section registration, formatting of successful results, propagation of backend `FsError` codes into `isError` tool results through `ctx.tools.execute()`, that read/write/edit pass the current execution context or structural projection through to `ctx.fs`, root-plugin suite registration, subpath plugin registration, and HMR cleanup.

Integration tests should load `dsh-fs-local` plus `dsh-tool-fs` and execute `read`, `write`, and `edit` through `ctx.tools.execute()` to prove the three packages work together without bypassing the tool registry. They must verify the world, not the tool's self-report: after a `write`/`edit`, read the file back from disk and assert byte-identical content (and that untouched files are unchanged), rather than trusting the returned `ContentBlock[]`. Each integration/e2e test owns its resources — create the harness in the test, run against a per-test temporary directory, and dispose the harness and remove the directory in `afterEach` even on failure or timeout.

Repo gates for the implementation include the focused vitest suites, `yarn typecheck`, `yarn test:coverage` for runtime code, and build/publint coverage after adding package entrypoints.

## Risks

**`cwd` can be mistaken for a sandbox.** The local backend's base directory is a resolution default, not automatically a containment boundary. If containment is required, it must be enforced by the backend contract or by a permission/sandbox plugin on `tools/execute`.

**The interface can become too local.** Returning fields such as `absolutePath` from `ctx.fs` would make remote, sandboxed, or virtual backends awkward. The contract should expose display metadata without requiring consumers to understand host paths.

**The interface can become too thin.** If `ctx.fs` only mirrors `node:fs` primitives, `tool-fs` will reimplement binary detection, pagination, atomic writes, and edit semantics. That recreates the coupling this RFC is trying to avoid.

**Edit semantics are race-prone.** Literal edit is a read-modify-write operation. Without a stale-content guard or backend-level atomic edit primitive, concurrent edits can overwrite each other. The first implementation should document its guarantees clearly; stronger compare-and-swap semantics can be added later if needed.

**File state inside `ctx.fs` can blur concerns.** Recording what an execution context has seen is workflow state, not raw filesystem I/O. This RFC still keeps it inside the filesystem seam because write/edit safety depends on backend-defined target identity and version tokens, and because putting it in `tool-fs` would couple write/edit to the read tool implementation. The boundary is narrow: `ctx.fs` derives the file-state owner, records file state, and checks stale versions, while `tool-fs` owns only model-facing schemas and formatting.

**The `resolve`-then-operate shape costs an extra round-trip per call.** Each tool may resolve a path to an `FsTarget` and then issue the read/write/edit as a separate `ctx.fs` call. For the local backend this is negligible (resolution is in-memory path normalization), but a remote/sandboxed backend may turn each step into its own request, so a single `read` can become two network round-trips. Backends where the round-trip matters can cache or fold resolution internally while preserving the observable contract.

**File-state persistence is deferred.** The first implementation can keep file state in memory. Resumed sessions should conservatively require files to be read again before write/edit tools accept updates until a future session-event or persistence mechanism makes file state replayable.

**Error codes become part of the seam.** `FsError` codes make stale-version and observation failures machine-routable through the existing structured error taxonomy. The cost is that `dsh-fs` imports the shared `HarnessError` base from `dsh-llm`; that dependency is intentional and should stay limited to the error vocabulary.

**Package churn is front-loaded.** The three-package split adds boilerplate before there is more than one backend. This is intentional: filesystem access is a likely sandbox/remote boundary, and changing the package surface after shipping model-facing tools would be more expensive.
