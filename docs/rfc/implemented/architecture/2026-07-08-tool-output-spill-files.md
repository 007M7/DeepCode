# RFC: Tool output spill policy

Status: implemented

## Problem

Tool outputs need bounded model-facing previews, but some oversized results are still useful later. A fetched page body or a verbose tool response should not consume the next model request in full, but the model should be able to inspect the complete formatted result later with existing file-reading tools.

Before this change the behavior was uneven. `dsh-bash-local` already writes complete stdout/stderr streams to private temp spill files when its in-memory tail overflows, but ordinary text tool results were returned inline unless the tool hand-rolled its own cap. The [tool result retention library](./2026-07-06-tool-result-retention-library.md) owns preview mechanics, but it does not own storage or an execution-pipeline policy that applies those mechanics to final tool results.

The shape matches the timeout policy design: a tool author normally returns the text result, and a policy plugin enforces the deployment's default context budget. Tool-specific early spill remains possible later for outputs that do not survive to the final `ToolExecutionResult`; the first cut proves the default final-result path.

## Decision

A thin spill storage seam plus a default spill policy plugin, in a new `packages/spill/` group:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-spill` | Interface: `ctx.spillFiles`, vocabulary types, no filesystem implementation. |
| `@deepseek-ai/dsh-spill-local` | Local backend: private, session-scoped file storage on the host filesystem. |
| `@deepseek-ai/dsh-spill-policy` | Tool-result policy plugin: wraps final text results after dispatch and replaces oversized results with a retained preview plus a spill-file path. |

There is no dedicated model-facing consumer package. The consumer is the existing `ctx.tools` execution pipeline: `dsh-spill-policy` consumes final tool results through the `tools/post-execute` waterfall, and the model uses the existing `read` tool to inspect the returned path.

### Spill seam

The storage seam is minimal: save text and return a local path.

```ts ignore-check
interface SpillFiles {
  saveText(input: SaveTextSpill): Promise<SpillRef>
}

interface SpillSource {
  toolName: string
  callId: CallId
  label: string
}

interface SaveTextSpill {
  owner: { sessionId: SessionId }
  source: SpillSource
  suggestedName: string
  content: string
}

type SpillPath = Branded<'SpillPath'>

interface SpillRef {
  path: SpillPath
  bytes: number
}
```

`SpillPath` is a [branded](../../../../packages/util/brand) local filesystem path returned by the backend and intended for `read`. The brand records that the path came from the spill seam (a runtime artifact); it is rendered to the model as an ordinary path string in v1. `SpillOwner` scopes storage to a `SessionId` — spill is inherently session-scoped, so the seam imports `dsh-session`'s `SessionId` directly rather than minting a decoupled token like the bash executor's `OwnerToken`.

`dsh-spill-local` owns only storage details: session-scoped directory selection, safe names, path-traversal protection, the write, and returning `{ path, bytes }`. It does not own retention policy, model-facing wording, tool-result replacement, search, or file inspection. Files land at `<root>/session-<hash>/<random>-<safeName>`, where `root` is a configured path or a lazily-created private (0700) per-process temp dir, the session subdir is a short `sha256(sessionId)` prefix, and the leaf is a random hex prefix plus the caller's `suggestedName` sanitized to one path segment (mirrors the JSONL backend's `encodeSegment`). The write is `open(path, 'wx', 0o600)` — exclusive and owner-only, so a planted symlink cannot redirect it.

The v1 local backend returns a real local `path` readable by the existing `read` tool. A future remote or virtual backend may replace this with a `spill://...` URI plus a read-only filesystem bridge; v1 keeps the interface path-shaped until that backend exists.

### Spill policy

`dsh-spill-policy` is a `tools/post-execute` result transformer with one configuration knob:

```ts ignore-check
interface Config {
  /** Omitted means no automatic spill policy. Present means apply to oversized plain text tool results. */
  maxInlineBytes?: number
}
```

When `maxInlineBytes` is omitted the plugin registers nothing (a true no-op). When set, it applies a default policy to final plain-text tool results:

1. Let the tool run normally, delegating via `next()` so a downstream listener settles the result first.
2. Flatten the accepted final `ContentBlock[]` only when it is entirely plain text; a result with any non-text block is left untouched.
3. If its UTF-8 byte size is at or below `maxInlineBytes`, leave it unchanged.
4. If it is larger, call `ctx.spillFiles.saveText()` with the full final text.
5. Replace the model-facing result with a retained head/tail preview plus the spill path.

The preview is an implementation default owned by the policy: a head/tail split of `maxInlineBytes` via the retention library's `TextRetainer`. Future config can expose preview sizing only after a second deployment needs it.

The replacement text is intentionally generic because the policy only knows the final formatted tool result, not the tool's internal resource:

```text
<retained preview>

(Omitted N bytes. Full formatted result saved to: /.../session-.../....txt. Use read with offset/limit to inspect it.)
```

If `ctx.spillFiles.saveText()` fails (permissions, ENOSPC, backend unavailable), or the call has no session owner, or no backend is loaded, the plugin logs the reason and returns the original result unchanged. Spill failure never turns a successful tool call into an `isError` result or hides the inline result.

The policy skips `read` to avoid a circular `read -> spill file -> read again` loop. Additional opt-out configuration is deferred until a real second tool needs it.

## Showcase: web_fetch

`web_fetch` is the first showcase because it returns a naturally large text result and needs no tool-specific spill code. The tool is ordinary:

```ts ignore-check
ctx.tools.register(defineTool({
  name: 'web_fetch',
  async execute(args, exec) {
    const result = await ctx.web.fetch({ url: args.url }, exec.signal ? { signal: exec.signal } : undefined)
    return [{ type: 'text', text: formatFetchOutput(result) }]
  },
}))
```

With `dsh-spill-policy` configured, a large formatted fetch result is automatically retained and spilled. A deployment demonstrates the behavior by setting the provider resource cap higher than the policy cap:

```yaml
- id: web-fetch-local
  name: '@deepseek-ai/dsh-web-fetch-local'
  config:
    maxBodyChars: 500000

- id: spill-local
  name: '@deepseek-ai/dsh-spill-local'

- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

This separation is important. `web-fetch-local` still owns resource caps (`maxResponseBytes`, `maxBodyChars`) to protect network, memory, and decoding work. `spill-policy` owns only the model-facing context cap after the result already exists. If the provider already returned `truncated: true`, the spill file contains the full formatted result the tool returned, not the full original webpage; the policy does not claim otherwise.

## Relationship to retention and early spill

Retention is separate from spill storage:

- `@deepseek-ai/dsh-retention` owns preview mechanics (`TextRetainer`, `ItemRetainer`, and omitted metadata).
- `@deepseek-ai/dsh-spill` owns saving final text to a session-scoped path.
- `@deepseek-ai/dsh-spill-policy` applies the default final-result policy in the tool pipeline, composing the two.

The final-result policy cannot replace tool-owned early spill. Some useful content is not present in final `ToolExecutionResult.content`:

- `bash` final output is already a tail plus a temp spill path; the complete stdout/stderr streams live in executor files.
- `subagent` final output is the child final answer, not the child rollout.
- Future tools may produce runtime artifacts that are never represented by their final `ToolExecutionResult.content`.

Those cases can consume `ctx.spillFiles` directly in later work. They are not part of the first showcase.

## Non-goals

- No new model-facing `artifact_read` or `artifact_search` tool in v1.
- No per-tool retention configuration in v1.
- No model-facing timeout/truncation arguments.
- No migration of `read` output into spill files.
- No replacement for provider/resource caps such as `web-fetch-local.maxBodyChars`.
- No bash temp-file normalization or subagent rollout capture in the first cut.

## Deferred

- `saveFile()` / `linkOrCopy` for existing executor spill files, needed for bash normalization.
- Tool-owned spill for subagent rollouts (`await run.result`, read in-process child session before `run.dispose()`, save JSONL).
- Per-tool opt-out or per-tool policy declarations if the built-in `read` skip is insufficient.
- A virtual `spill://` URI and read-only filesystem bridge.
- Remote storage backends for ACP or remote environments where a local path is not meaningful.
- Cleanup and retention policy for old spill files, likely tied to session cleanup.

## Testing

- `dsh-spill` unit tests pin the seam contract: registration as `ctx.spillFiles`, one-implementation-per-context, and disposal release.
- `dsh-spill-local` unit tests cover `saveText`, `encodeSegment` sanitization (separators/tilde/whole-segment dots/empty), the session-hash directory, owner-only permissions, distinct paths per save, the configured/private root, and a storage-failure rejection.
- `dsh-spill-policy` unit tests drive real tools through `ctx.tools.execute`: disabled-mode no-op, oversized-text replacement, small/non-text passthrough, `read` skip, best-effort fallback (save failure / no backend / no owner), and downstream-composition (bounding a replaced result, preserving `additionalContext`).
- `dsh-tool-web` integration drives `web_fetch` through `ctx.tools.execute` with the real `spill-local` backend + policy, proving the model-facing text changes only by the deliberate spill notice while the spill file holds the full formatted result.
- The `coding-agent` example loads `spill-local` + `spill-policy`, so its keyless Loader smoke exercises the real load path (the namespace-plugin export shape + `inject`).

## Consequences

The default policy only sees final formatted text. It cannot preserve provider-internal content that was already capped or runtime artifacts that were never part of the result. This is acceptable for the first cut because the showcase is final-result spill, not early spill; tool-owned early spill remains deferred work.

Returning real paths from the local backend keeps v1 simple and matches proven agent-tool behavior, but it exposes implementation paths to the model and may not work for remote backends. The interface should be revisited when a virtual or remote spill backend exists.

The v1 value proposition depends on the existing `read` tool being able to inspect the returned local path, even when the spill directory is outside the session cwd. That holds today because the filesystem policy records observations and write guards but does not confine reads to the workspace. A future workspace-confinement policy must either allow spill paths explicitly or provide a read-only spill bridge, or the spill notice would point at an unreadable path.

**Snapshot gap.** No ACP snapshot scenario covers the transcript-visible `web_fetch` spill notice yet. The ACP snapshot harness replays keyless and cannot hit the live web, and a `web_fetch` spill requires a real over-cap HTTP body; a deterministic scenario would need a seeded loopback fetch target the replay tree does not currently wire (the examples do not load `tool-web` at all). The behavior is covered instead by the `dsh-tool-web` integration test against a loopback server. Closing the gap is follow-up work: wire `tool-web` + a seeded fetch target into the ACP example, then record a `web-fetch-spill` scenario.

The policy can become too large if it starts owning tool-specific semantics. It stays narrow: plain-text final results only. Tool-owned early spill remains future work.

## Alternatives considered

**Require each tool to opt in with a retention declaration.** Rejected for v1: the goal is a default behavior similar to Claude Code's generic tool-result persistence. A single `maxInlineBytes` deployment knob is enough to prove the shape.

**Make `tool-results` a broad tool-result platform.** Rejected: a broad package name invites retention policy, result replacement, preview wording, search, and early spill into one seam. The shared storage part is smaller: save text and return a path.

**Use `ctx.fs.writeText` or the model-facing `write` tool.** Rejected: workspace filesystem writes carry project-file semantics, write/edit policy, observation state, and user-facing side effects. Spill files are runtime artifacts, not model-authored workspace edits. The existing `read` tool may inspect them later, but creation belongs to the runtime spill seam.

**Let `web-fetch-local` fetch without caps and rely on spill-policy.** Rejected: spill-policy runs after the final tool result exists and cannot protect network, memory, or decoding resources. Provider resource caps stay mandatory.

**Merge retention into spill.** Rejected: retention and spill have different responsibilities. `TextRetainer`/`ItemRetainer` decide what preview is kept and what was omitted; spill storage only saves the final text the policy asks it to save.
