# Agent Note: E2B interactive, semantic, and code-runtime POC

Status: implemented

English | [中文](2026-07-28-e2b-interactive-semantic-code-runtime-poc.zh.md)

## Problem

The [shared E2B runtime](2026-07-27-e2b-remote-runtime-poc.md) proves that filesystem operations and one-shot commands can inhabit one remote coding world, but an assembled coding agent also uses persistent terminals, language servers, and model-written Code Mode programs. Falling back to host implementations for those capabilities splits observable state: a Bash edit exists in E2B while a host PTY, LSP process, or code worker addresses a different filesystem and process namespace.

Moving the complete harness process into E2B would unify that state but also changes plugin loading, credentials, model transport, session durability, supervision, and deployment. The POC needs to test the existing capability boundaries without taking on those independent concerns.

## Decision

Three opt-in providers extend the existing shared sandbox:

- `@deepseek-ai/dsh-pty-e2b` registers an E2B byte-PTY backend on `ctx.pty` and keeps exact-Agent ownership in the existing registry.
- `@deepseek-ai/dsh-lsp-e2b` registers configured remote language servers on `ctx.lsp`, reads source through E2B Filesystem APIs, and runs servers through `dsh-subprocess-e2b`.
- `@deepseek-ai/dsh-code-runtime-e2b` registers `ctx.codeRuntime`, runs each model program in a fresh remote worker, and dispatches binding functions in the host process.

All three inject `ctx.e2b`; none creates another sandbox. The opt-in overlay composes them with `dsh-fs-e2b`, `dsh-subprocess-e2b`, and the existing `dsh-bash-local`, so files, foreground commands, interactive shell processes, language servers, and code workers observe one remote cwd.

The providers reuse the PTY, LSP, Code Runtime, and subprocess seams without changing their model-facing consumers or the agent loop. Backend-neutral PTY text handling moves into `dsh-pty`; the LSP protocol engine accepts `processId: null` for a server in another process namespace; Code Runtime exports its output-ledger and lossless-JSON helpers for backend parity.

## Runtime boundary

E2B owns the mutable filesystem, command and Bash processes, PTY shell and foreground process groups, language-server processes and source reads, the Code Runtime runner and worker, and adapter-private files under `.dsh-e2b`.

The host owns Cordis and plugin objects, agent/session/goal state, session logs and persistence, LLM calls, prompts and tools, authority decisions, PTY buffers and readiness state, LSP JSON-RPC ids/queues/protocol state, Code Runtime type stripping/output accounting/binding dispatch, and E2B SDK/network orchestration. The host workspace is not mounted or synchronized merely because its absolute cwd string is reused remotely.

Byte-sensitive protocols use the narrowest adapter needed for E2B's callback shapes. PTY consumes the SDK's byte callback directly. LSP and Code Runtime install dependency-free remote helpers that encode raw payloads as validated newline-delimited base64 JSON, keeping E2B's decoded command callbacks on an ASCII transport.

Retaining a sandbox preserves remote files and any unmanaged remote state only. Reconnect does not reconstruct host PTY sessions, buffers, process handles, LSP connections or requests, code workers, binding calls, timers, output cursors, or locks. Managed groups are terminated and awaited when their provider disposes before the shared owner pauses, leaves, or kills the sandbox.

## Verification

Focused unit suites pin configuration, publication rollback, byte framing, multibyte boundaries, readiness, signals, timeout/abort ordering, output limits, hostile Code Runtime traffic, and disposal to quiescence. Adjacent local-backend suites pin the shared PTY utilities and the LSP cross-namespace `processId` behavior.

A credential-gated Loader composition creates one real E2B sandbox and exercises FS-to-Bash and Bash-to-FS visibility, multibyte PTY output and `SIGINT`, multibyte LSP hover and definition results, Code Runtime host bindings and typed rejection under mutation of adapter-captured intrinsics, wall timeout, abort, runner cleanup, host-workspace isolation, and final sandbox deletion. The same scenario runs through source imports and built package exports.

## Alternatives considered

**Run the complete harness inside E2B** — rejected because it couples this provider experiment to credentials, LLM transport, plugin deployment, session persistence, supervision, and remote package installation. None is necessary to prove the capability seams.

**Use the host PTY, LSP, and worker backends unchanged** — rejected because they use host process and filesystem APIs; sharing an absolute cwd string does not share state across machines.

**Expose E2B Commands as one generic transport and bypass capability providers** — rejected because PTY needs byte callbacks and foreground signaling, LSP needs byte-faithful stdio plus remote source containment, and Code Runtime needs bidirectional host binding calls and hostile-peer validation. Bypassing their registries would also fork model-facing behavior.

**Add a generic distributed-runtime abstraction first** — rejected because the three existing capability seams already carry the required contracts. A new cross-cutting interface would speculate about persistence, synchronization, and reconnect semantics beyond the POC.

**Restore live capability handles after `sandboxId` reconnect** — rejected because remote identity alone cannot reconstruct host callbacks, pending promises, authority, protocol state, or output cursors. Claiming continuity would make stale remote processes appear managed when they are not.

## Consequences

The assembled POC keeps the coding world remote without moving the agent runtime or changing model-visible tool contracts. It demonstrates that PTY, LSP, and Code Runtime can share E2B state through existing plugins, while making the remaining host state explicit.

This is not a deployment platform. Language-server installation, templates, volumes, snapshots, network policy, workspace synchronization, durable remote handles, and whole-harness execution remain outside scope. E2B SDK buffering and host protocol state remain memory costs. Code programs share a JavaScript realm with Node worker internals, and a process that deliberately escapes a captured remote process group is not made reconnectable or owned by this composition.
