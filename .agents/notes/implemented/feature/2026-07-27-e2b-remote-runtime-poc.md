# Agent Note: Shared E2B remote runtime POC

Status: implemented

English | [中文](2026-07-27-e2b-remote-runtime-poc.zh.md)

## Problem

A remote coding-agent backend is useful only when file operations and commands observe one coherent world. Attaching E2B independently at individual tools would allow a Bash command and a filesystem edit to address different sandboxes, while moving the complete harness into a remote VM would couple provider experimentation to agent, session, model, persistence, and deployment changes.

## Decision

The E2B integration is a provider-composition POC with one shared lifecycle owner and two capability implementations:

- `@deepseek-ai/dsh-e2b` creates or reconnects one secure E2B sandbox, creates its working and private runtime directories, and owns kill/pause/leave disposal.
- `@deepseek-ai/dsh-fs-e2b` implements `ctx.fs` over that sandbox's Filesystem API.
- `@deepseek-ai/dsh-subprocess-e2b` implements `ctx.subprocess` over E2B Commands and remote Linux process groups.
- The existing `@deepseek-ai/dsh-bash-local` remains the Bash implementation because it delegates all process mechanics to `ctx.subprocess`.
- PTY, LSP, and Code Runtime remain separate capability providers over the same owner, with their runtime split recorded in the [extension decision](2026-07-28-e2b-interactive-semantic-code-runtime-poc.md).

The owner is the sole source of sandbox identity. Providers inject it and never create private sandboxes. The composition therefore gives filesystem tools and Bash one remote cwd, process namespace, and spill/state directory while preserving the existing capability interfaces and model-facing tools.

## POC boundary

Filesystem state, managed commands, interactive shells, language servers, code workers, and adapter-owned files move into E2B. The host retains Cordis and plugin objects, the agent loop, agent/session state, session logs and persistence, model requests, skills, subagent orchestration, capability protocol state, and E2B SDK buffers. The overlay does not upload or mount the host workspace; identical cwd strings name independent host and remote directories. Managed process groups still terminate and join when their provider disposes, including before a retained-sandbox pause or leave disposition.

The POC has no session-persistence backend, template builder, volume, snapshot, network-policy layer, sandbox catalog, or workspace synchronization. Retained sandbox reconnect proves lifecycle continuity only; it does not reconstruct host PTY/LSP/code-runtime state, process handles, output cursors, pending calls, or locks.

## Verification

Package tests pin lifecycle cleanup, filesystem semantics, subprocess groups, byte framing, PTY readiness/signals, LSP transport and containment, Code Runtime binding/output behavior, and package-owned invariant registrations. A credential-gated real Loader composition creates one sandbox, exercises filesystem, Bash/subprocess, PTY, LSP, and Code Runtime through source and built package paths, proves host-workspace isolation, disposes the composition, and confirms the sandbox id is gone.

## Alternatives considered

**A separate E2B sandbox per capability or tool** — rejected because file and command operations would not share identity or state, defeating the coding-agent use case and multiplying lifecycle ownership.

**Run the entire harness process inside E2B** — rejected because it changes deployment, credential flow, model transport, session durability, plugin loading, and supervision at once. Those questions are independent of proving the provider seams.

**Put every E2B capability in the shared owner package** — rejected because lifecycle identity is the owner's only concern. Filesystem, subprocess, PTY, LSP, and Code Runtime retain separate provider contracts, configuration, tests, and consumers; Bash continues to reuse its subprocess seam.

**Implement filesystem operations through shell commands only** — rejected because that bypasses `ctx.fs` identity, structured errors, version guards, streaming reads, and atomic mutation semantics already consumed by the file tools.

## Consequences

The small composition demonstrates that existing capability seams can move an agent's mutable coding world off-host without changing the loop or model-facing tool packages. `sandboxId` plus pause/leave permits manual state retention for experiments, while kill remains the demo's cleanup policy.

The provider is not interchangeable with local backends for every consumer: remote startup cannot synchronously expose a PID, E2B retains complete command output in SDK memory, ordinary command callbacks are not byte-faithful, signal attribution is partly inferred, and reconnect cannot restore handles or protocol state. PTY uses E2B's byte API; LSP and Code Runtime add validated ASCII framing where protocol bytes matter. Remote process/spill artifacts accumulate in a retained sandbox. These gaps remain documented POC constraints rather than compatibility shims or new cross-cutting abstractions.
