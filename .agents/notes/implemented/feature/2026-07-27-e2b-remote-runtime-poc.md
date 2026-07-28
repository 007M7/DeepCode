# Agent Note: Shared E2B remote runtime POC

Status: implemented

English | [中文](2026-07-27-e2b-remote-runtime-poc.zh.md)

## Problem

A remote coding-agent backend is useful only when filesystem operations, one-shot commands, persistent terminals, language servers, and model-written programs observe one coherent world. Attaching E2B independently at individual tools would let those capabilities address different sandboxes, while retaining host PTY, LSP, or worker backends would split state across machines even when the cwd strings match.

Moving the complete harness into a remote VM would unify that state but also couple provider experimentation to plugin loading, credentials, model transport, agent/session durability, supervision, and deployment. The POC needs to test the existing capability boundaries without taking on those independent concerns.

## Decision

The E2B integration is an opt-in provider-composition POC. Its three E2B-specific packages live together under `packages/e2b/`:

- `@deepseek-ai/dsh-e2b` creates or reconnects one secure E2B sandbox, creates its working and private runtime directories, and owns kill/pause/leave disposal.
- `@deepseek-ai/dsh-fs-e2b` implements `ctx.fs` over that sandbox's Filesystem API.
- `@deepseek-ai/dsh-subprocess-e2b` implements `ctx.subprocess` over E2B Commands, byte PTYs, and remote Linux process groups.

The higher capabilities use provider-neutral implementations. `dsh-bash-local` delegates command mechanics to `ctx.subprocess`; `dsh-pty-local` delegates terminal allocation and signalling to `ctx.subprocess.spawnTerminal()`; `dsh-lsp-local` reads through `ctx.fs` and launches through `ctx.subprocess`; `dsh-code-runtime-subprocess` materializes its runner through `ctx.fs` and starts it through `ctx.subprocess`. The [portable execution-world decision](../architecture/2026-07-28-portable-execution-world-consumers.md) owns those generic interfaces and consumers.

The E2B owner is the sole source of sandbox identity. Its two adapters never create private sandboxes, so filesystem tools, Bash, interactive shells, language servers, and code workers share one remote cwd, process namespace, and adapter-private directory while preserving the existing capability interfaces, generic implementations, model-facing tools, and agent loop.

## POC boundary

E2B owns the mutable filesystem, managed command and Bash processes, terminal allocation and terminal-session process groups, language-server processes and source reads, the Code Runtime launcher, controller, and worker, and adapter-private files under `.dsh-e2b`.

The host owns Cordis and plugin objects, the agent loop, agent/session/goal state, session logs and persistence, LLM calls, prompts and tools, authority decisions, skills, subagent orchestration, PTY buffers and readiness state, LSP JSON-RPC ids/queues/protocol state, Code Runtime type stripping/output accounting/binding dispatch, and E2B SDK/network orchestration. The overlay does not upload, mount, or synchronize the host workspace; identical cwd strings name independent host and remote directories.

The fundamental adapters carry the substrate-specific mechanics. `dsh-subprocess-e2b` consumes E2B's byte PTY callback directly, retains terminal send identity across asynchronous foreground-group lookup, and owns whole-session cleanup. `dsh-fs-e2b` performs bounded source reads through a dependency-free helper that walks no-follow directory descriptors beneath the canonical target. Generic Code Runtime keeps its controller/worker protocol on validated ASCII/base64 frames and kills the provider-owned process group before inherited pipes drain. Generic LSP uses UTF-8 JSON over command pipes; E2B's decoded callback transport is not an arbitrary binary channel.

Retaining a sandbox preserves remote files and unmanaged remote state only. Reconnect does not reconstruct host PTY sessions, buffers, process handles, LSP connections or requests, code workers, binding calls, timers, output cursors, or locks. Managed groups terminate and join when their provider disposes before the shared owner pauses, leaves, or kills the sandbox.

The POC has no session-persistence backend, template builder, volume, snapshot, network-policy layer, sandbox catalog, workspace synchronization, durable remote handles, or whole-harness execution.

## Verification

Focused package suites pin owner lifecycle cleanup, filesystem paths/containment/bounded descriptor reads and commit metadata, subprocess executable lookup/process groups/publication rollback, terminal byte I/O/signal identity/default-environment scrubbing/session cleanup, output limits, abort ordering, disposal to quiescence, and package-owned invariant registrations. The generic PTY, LSP, and subprocess Code Runtime suites pin their provider-neutral readiness, cross-namespace `processId`, binding bridge, descriptor isolation, hostile traffic, and worker/descendant cleanup behavior.

A credential-gated Loader composition creates real E2B sandboxes and exercises FS-to-Bash and Bash-to-FS visibility, process-publication rollback, bounded spill output, PTY default-secret scrubbing, stale-interrupt identity, and process-tree cleanup, parent-swap-safe bounded LSP source reads, Code Runtime host bindings, descriptor-isolated output accounting, descendant-held pipe cleanup, wall timeout, abort, runner cleanup, host-workspace isolation, and final sandbox deletion. The same composition runs through source imports and built package exports.

## Alternatives considered

**A separate E2B sandbox per capability or tool** — rejected because file and command operations would not share identity or state, defeating the coding-agent use case and multiplying lifecycle ownership.

**Run the entire harness process inside E2B** — rejected because it changes deployment, credential flow, model transport, session durability, plugin loading, and supervision at once. Those questions are independent of proving the provider seams.

**Put every E2B operation in the shared owner package** — rejected because lifecycle identity is the owner's only concern. Filesystem and subprocess retain separate provider contracts, tests, and consumers; the owner exposes one shared SDK handle without becoming a capability grab bag.

**Implement filesystem operations through shell commands only** — rejected because that bypasses `ctx.fs` identity, structured errors, version guards, streaming reads, and atomic mutation semantics already consumed by the file tools.

**Keep E2B-specific PTY, LSP, and Code Runtime packages** — rejected because their domain behavior does not vary with E2B. They were shallow adapters that duplicated existing consumers to replace filesystem and process operations; moving those operations behind the fundamental seams gives every provider one implementation of readiness, protocol, binding, and presentation behavior.

**Call E2B Filesystem, Commands, or PTY APIs directly from higher capabilities** — rejected because it bypasses the `ctx.fs` and `ctx.subprocess` contracts, duplicates execution-world policy in each consumer, and forks model-facing behavior. The subprocess seam includes the irreducible terminal primitive because ordinary pipes cannot supply foreground groups or whole-session cleanup.

**Add a generic distributed-runtime abstraction first** — rejected because the existing capability seams already carry the required contracts. A new cross-cutting interface would speculate about persistence, synchronization, and reconnect semantics beyond the POC.

**Restore live capability handles after `sandboxId` reconnect** — rejected because remote identity alone cannot reconstruct host callbacks, pending promises, authority, protocol state, or output cursors. Claiming continuity would make stale remote processes appear managed when they are not.

## Consequences

The three-package composition demonstrates that filesystem and subprocess are the sufficient provider seams for moving an agent's mutable coding world off-host without changing the loop, higher capability implementations, or model-facing tool packages. Fixes to Bash, PTY, LSP, and Code Runtime remain provider-neutral. `sandboxId` plus pause/leave permits manual remote-file retention for experiments, while kill remains the demo's cleanup policy.

The adapters are not interchangeable with local backends for every consumer: remote startup cannot synchronously expose a PID, E2B retains complete command output in SDK memory, command callbacks are text-decoded rather than arbitrary binary streams, exact terminal stdin-wait inspection is unavailable, signal attribution is partly inferred, and reconnect cannot restore handles or protocol state. PTY uses E2B's byte API; Code Runtime uses validated ASCII/base64 framing; the exercised LSP path carries valid UTF-8 JSON. Remote process/spill artifacts accumulate in a retained sandbox, Code programs share a JavaScript realm with Node worker internals, and a process that deliberately escapes a managed process group or terminal session does not become reconnectable or owned. These gaps remain documented POC constraints rather than compatibility shims or new cross-cutting abstractions.
