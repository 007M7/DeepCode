# Agent Note: Shared E2B remote runtime POC

Status: implemented

English | [中文](2026-07-27-e2b-remote-runtime-poc.zh.md)

## Problem

A remote coding-agent backend is useful only when filesystem operations, one-shot commands, persistent terminals, language servers, and model-written programs observe one coherent world. Attaching E2B independently at individual tools would let those capabilities address different sandboxes, while retaining host PTY, LSP, or worker backends would split state across machines even when the cwd strings match.

Moving the complete harness into a remote VM would unify that state but also couple provider experimentation to plugin loading, credentials, model transport, agent/session durability, supervision, and deployment. The POC needs to test the existing capability boundaries without taking on those independent concerns.

## Decision

The E2B integration is an opt-in provider-composition POC. Its six E2B-specific packages live under `packages/e2b/` while retaining seam-specific npm names:

- `@deepseek-ai/dsh-e2b` creates or reconnects one secure E2B sandbox, creates its working and private runtime directories, and owns kill/pause/leave disposal.
- `@deepseek-ai/dsh-fs-e2b` implements `ctx.fs` over that sandbox's Filesystem API.
- `@deepseek-ai/dsh-subprocess-e2b` implements `ctx.subprocess` over E2B Commands and remote Linux process groups.
- `@deepseek-ai/dsh-pty-e2b` registers an E2B byte-PTY backend on `ctx.pty` while the existing registry retains exact-Agent ownership.
- `@deepseek-ai/dsh-lsp-e2b` registers configured remote language servers on `ctx.lsp`, reads source through E2B Filesystem APIs, and runs servers through `dsh-subprocess-e2b`.
- `@deepseek-ai/dsh-code-runtime-e2b` registers `ctx.codeRuntime`, runs each model program in a fresh remote worker, and dispatches binding functions in the host process.
- The existing `@deepseek-ai/dsh-bash-local` remains the Bash implementation because it delegates all process mechanics to `ctx.subprocess`.

The owner is the sole source of sandbox identity. Providers inject it and never create private sandboxes, so filesystem tools, Bash, interactive shells, language servers, and code workers share one remote cwd, process namespace, and adapter-private directory while preserving the existing capability interfaces and model-facing tools.

The providers reuse the PTY, LSP, Code Runtime, and subprocess seams without changing their model-facing consumers or the agent loop. Backend-neutral PTY text handling lives in `dsh-pty`; the LSP protocol engine accepts `processId: null` for a server in another process namespace; Code Runtime exports its output-ledger and lossless-JSON helpers for backend parity.

## POC boundary

E2B owns the mutable filesystem, command and Bash processes, PTY shell and foreground process groups, language-server processes and source reads, the Code Runtime runner and worker, and adapter-private files under `.dsh-e2b`.

The host owns Cordis and plugin objects, the agent loop, agent/session/goal state, session logs and persistence, LLM calls, prompts and tools, authority decisions, skills, subagent orchestration, PTY buffers and readiness state, LSP JSON-RPC ids/queues/protocol state, Code Runtime type stripping/output accounting/binding dispatch, and E2B SDK/network orchestration. The overlay does not upload, mount, or synchronize the host workspace; identical cwd strings name independent host and remote directories.

Byte-sensitive protocols use the narrowest adapter required by E2B's callback shapes. PTY consumes the SDK's byte callback directly. LSP and Code Runtime install dependency-free remote helpers that encode raw payloads as validated newline-delimited base64 JSON, keeping E2B's decoded command callbacks on an ASCII transport.

Retaining a sandbox preserves remote files and unmanaged remote state only. Reconnect does not reconstruct host PTY sessions, buffers, process handles, LSP connections or requests, code workers, binding calls, timers, output cursors, or locks. Managed groups terminate and join when their provider disposes before the shared owner pauses, leaves, or kills the sandbox.

The POC has no session-persistence backend, template builder, volume, snapshot, network-policy layer, sandbox catalog, workspace synchronization, durable remote handles, or whole-harness execution.

## Verification

Focused package suites pin owner lifecycle cleanup, filesystem semantics, subprocess process groups, configuration and publication rollback, byte framing and multibyte boundaries, PTY readiness/signals, LSP transport and source containment, Code Runtime bindings, hostile traffic, output limits, timeout/abort ordering, disposal to quiescence, and package-owned invariant registrations. Adjacent local-backend suites pin the shared PTY utilities and the LSP cross-namespace `processId` behavior.

A credential-gated Loader composition creates one real E2B sandbox and exercises FS-to-Bash and Bash-to-FS visibility, multibyte PTY output and `SIGINT`, multibyte LSP hover and definition results, Code Runtime host bindings and typed rejection under mutation of adapter-captured intrinsics, wall timeout, abort, runner cleanup, host-workspace isolation, and final sandbox deletion. The same scenario runs through source imports and built package exports.

## Alternatives considered

**A separate E2B sandbox per capability or tool** — rejected because file and command operations would not share identity or state, defeating the coding-agent use case and multiplying lifecycle ownership.

**Run the entire harness process inside E2B** — rejected because it changes deployment, credential flow, model transport, session durability, plugin loading, and supervision at once. Those questions are independent of proving the provider seams.

**Put every E2B capability in the shared owner package** — rejected because lifecycle identity is the owner's only concern. Filesystem, subprocess, PTY, LSP, and Code Runtime retain separate provider contracts, configuration, tests, and consumers; Bash continues to reuse its subprocess seam.

**Implement filesystem operations through shell commands only** — rejected because that bypasses `ctx.fs` identity, structured errors, version guards, streaming reads, and atomic mutation semantics already consumed by the file tools.

**Use the host PTY, LSP, and worker backends unchanged** — rejected because they use host process and filesystem APIs; sharing an absolute cwd string does not share state across machines.

**Expose E2B Commands as one generic transport and bypass capability providers** — rejected because PTY needs byte callbacks and foreground signaling, LSP needs byte-faithful stdio plus remote source containment, and Code Runtime needs bidirectional host binding calls and hostile-peer validation. Bypassing their registries would also fork model-facing behavior.

**Add a generic distributed-runtime abstraction first** — rejected because the existing capability seams already carry the required contracts. A new cross-cutting interface would speculate about persistence, synchronization, and reconnect semantics beyond the POC.

**Restore live capability handles after `sandboxId` reconnect** — rejected because remote identity alone cannot reconstruct host callbacks, pending promises, authority, protocol state, or output cursors. Claiming continuity would make stale remote processes appear managed when they are not.

## Consequences

The small composition demonstrates that existing capability seams can move an agent's mutable coding world off-host without changing the loop or model-facing tool packages. `sandboxId` plus pause/leave permits manual remote-file retention for experiments, while kill remains the demo's cleanup policy.

The providers are not interchangeable with local backends for every consumer: remote startup cannot synchronously expose a PID, E2B retains complete command output in SDK memory, ordinary command callbacks are not byte-faithful, signal attribution is partly inferred, and reconnect cannot restore handles or protocol state. PTY uses E2B's byte API; LSP and Code Runtime add validated ASCII framing where protocol bytes matter. Remote process/spill artifacts accumulate in a retained sandbox, Code programs share a JavaScript realm with Node worker internals, and a process that deliberately escapes a captured remote process group does not become reconnectable or owned. These gaps remain documented POC constraints rather than compatibility shims or new cross-cutting abstractions.
