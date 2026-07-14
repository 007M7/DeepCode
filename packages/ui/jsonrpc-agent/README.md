# @deepseek-ai/dsh-jsonrpc-agent

The **JSON-RPC SDK server app bin** (`dsh-jsonrpc-agent`): boot a harness from an externally supplied `cordis.yml` and let its [`@deepseek-ai/dsh-jsonrpc`](../jsonrpc/README.md) entry serve SDK clients over newline-delimited JSON-RPC on stdio. Structurally the SDK-runtime sibling of [`acp-agent`](../acp-agent/README.md)'s bin, but bin-only: there is no composition plugin here, because "the plugins that actually start come from the external config" is the SDK runtime's hard semantic — the leaf `cordis.yml` composes the spine, the backends, AND the serving face. This package is the entrypoint of the single-exe distribution (its `lib/bin.js` is what the packaged executable runs) — see [docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md](../../../docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).

## Config discovery

Two channels, environment first: `$DSH_CORDIS_CONFIG` (the existing SDK-client convention, wins), then the `argv[2]` positional path (`dsh-jsonrpc-agent <path/to/cordis.yml>`, the human channel). An empty value counts as absent on either channel. Neither given, or the path missing on disk: the bin prints a one-line usage naming both channels to stderr and exits 1 — there is no default `./cordis.yml` and no built-in fallback config. A config that names a plugin which fails to load fails loud through the shared [`dsh-app-boot`](../app-boot/README.md) guards (`assertEntriesLoaded` + the unhandled-rejection handler), never a silent half-boot. There is no `DSH_SNAPSHOT` handling: this protocol is not part of the ACP snapshot tier.

Note the deliberate flip side of config-decides-everything: a config that loads no `dsh-jsonrpc` entry boots fine and serves nothing — the bin cannot know which plugin is "the server".

## Exit lifecycle

The bin owns the PROCESS-level exits: stdin EOF (the SDK client is gone — an in-flight turn is deliberately cut off, see the risk note in docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) and `SIGTERM` dispose the root context to quiescence and exit 0; `SIGINT` does the same but exits 130. The PROTOCOL-level exit — a `shutdown` JSON-RPC request answered first, then exit 0 — is owned by the `dsh-jsonrpc` plugin, which holds the server and transport; the two paths are individually idempotent and safe to race.

## stdout is the protocol

stdout carries only JSON-RPC frames; the bin and the app-boot guards write diagnostics to stderr only, and the booted config must load no stdout logger (see the `dsh-jsonrpc` README).

## Model Experience

Indirectly, through the plugins loaded from the external `cordis.yml`, which own every model-bound prompt, schema, message, and result; this bin adds none of its own.

## Known Limitations and Deferred Work

- **The bin cannot prove that the config serves JSON-RPC** — a valid config with no `dsh-jsonrpc` entry boots successfully and serves nothing.
- **No built-in or default config exists** — every launch must provide `DSH_CORDIS_CONFIG` or a positional path, and deployment owns the complete plugin tree and stdout discipline.
- **stdin EOF cuts off in-flight work** — client disappearance disposes the root immediately; callers that need orderly completion use the protocol-level `shutdown` request.
