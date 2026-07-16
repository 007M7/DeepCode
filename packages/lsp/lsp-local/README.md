# @deepseek-ai/dsh-lsp-local

A **generic stdio language-server provider** for `ctx.lsp`. One plugin instance configures one server command and its extension-to-language-id map; load multiple instances for multiple servers. This is a generic host, not a language-server catalog or installer — deployments configure commands and mappings explicitly; presets belong in composition plugins or `cordis.yml` overlays.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export).

## What it does

- Lazily single-flights one server process per `(provider id, canonical workspace realpath)`. A crash fails the active query without replay; a later query may replace the process.
- Uses a compatibility-first **transient-open** sequence per query: canonicalize and read the source with Node APIs, `textDocument/didOpen` (version 1, full text), the requested request, then `textDocument/didClose` in `finally`. Documents close after each call, so the first version needs no `didChange`, content cache, or document LRU.
- Serializes queries through one abortable per-instance queue so a cancellation that fails to stop the server can terminate it without killing unrelated work; distinct instances run in parallel.
- Reads sources through Node filesystem APIs in the subprocess's host namespace — NOT `ctx.fs`, and emits no `fs/observed`: only the LSP result is model-visible, so a query does not satisfy read-before-write policy.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerId` | (required) | Stable provider id reserved on `ctx.lsp` with the extensions. |
| `command` | (required) | Executable to spawn — absolute, or resolved on the child PATH at load. Launch uses no shell. |
| `args` | `[]` | Arguments passed to the executable. |
| `env` | `{}` | Extra env merged on top of the credential-scrubbed ambient env (vars matching `KEY`/`SECRET`/`TOKEN` are not forwarded). |
| `extensionToLanguage` | (required) | Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). |
| `initializationOptions` | `null` | Static `initialize` options forwarded to the server. |
| `configuration` | `null` | Static answer to every `workspace/configuration` item. |
| `maxMessageBytes` | `16000000` | Largest single framed message accepted from the server. |
| `maxStderrBytes` | `1000000` | Largest stderr tail retained for diagnostics. |
| `maxDocumentBytes` | `4000000` | Largest source file this host will open. |
| `shutdownTimeoutMs` | `5000` | Graceful `shutdown`/`exit` budget before escalation. |
| `killGraceMs` | `2000` | SIGTERM→SIGKILL grace after graceful shutdown fails. |

The executable is resolved at load (after credential scrubbing); a missing command fails before registration. The process itself launches lazily on the first matching query.

## Protocol behavior

Initialization advertises `general.positionEncodings: ['utf-16']`, `workspace: { workspaceFolders: true, configuration: true }`, `textDocument.hover.contentFormat: ['markdown', 'plaintext']`, and `linkSupport: true` for definition and implementation, with no dynamic registration. The server's returned capabilities are authoritative: an unsupported operation, or synchronization without transient open/close, fails the query. An omitted server `positionEncoding` defaults to `utf-16`; any other value is a protocol error. The client answers `workspace/configuration` from static config, accepts lifecycle bookkeeping requests, and rejects `workspace/applyEdit` — it never applies edits or runs commands. Navigation maps `Location` directly and `LocationLink` from `targetUri` + `targetSelectionRange`; hover normalization takes `MarkupContent.value`, preserves string `MarkedString`s, renders language-tagged values as fenced code, and joins arrays with one blank line.

## Security boundary

The provider trusts its configured server and claims no sandbox confinement. It canonicalizes and reads source through Node APIs, rejecting a source that is missing, non-regular, non-UTF-8, oversized, or whose canonical path resolves outside the canonical workspace (symlink aliases share one instance). Result locations may be external, but an external path cannot become a query source. The first implementation therefore requires trusted host-local deployment; restricted, remote, or virtual workspaces require another provider.

## Model Experience

Indirectly, through `dsh-tool-lsp`, which surfaces this provider's normalized results; this host contributes no prompt or schema itself.

## Known Limitations and Deferred Work

- **Trusted host-local only** — no sandbox confinement, no private cache/temp write contract; supporting untrusted binaries or restricted/remote/virtual workspaces requires a later process/filesystem contract and a different provider ([seam RFC](../../../docs/rfc/implemented/architecture/2026-07-15-lsp-capability-seam.md)).
- **Transient-open compatibility floor** — servers whose synchronization omits open/close (or advertise `None`) are unsupported even if closed-document queries would work; the pinned TypeScript e2e establishes one compatibility floor, not a cross-language claim.
- **Per-instance serialization latency** — parallel agents sharing a workspace queue behind one process; long-lived workspace processes consume memory until disposal.
