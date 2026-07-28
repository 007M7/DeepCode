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

The owner is the sole source of sandbox identity. Providers inject it and never create private sandboxes. The composition therefore gives filesystem tools and Bash one remote cwd, process namespace, and spill/state directory while preserving the existing capability interfaces and model-facing tools.

## POC boundary

Only filesystem state, command processes during the provider lifetime, and adapter-owned remote files move into E2B. The host retains Cordis and plugin objects, the agent loop, agent/session state, session logs and persistence, model requests, skills, subagent orchestration, and E2B SDK buffers. The overlay does not upload or mount the host workspace; identical cwd strings name independent host and remote directories. Managed process groups still terminate and join when the subprocess service disposes, including before a retained-sandbox pause or leave disposition.

The POC has no PTY adapter, LSP-specific integration, session-persistence backend, code-runtime backend, template builder, volume, snapshot, network-policy layer, sandbox catalog, or workspace synchronization. Retained sandbox reconnect proves lifecycle continuity only; it does not reconstruct host process handles, output cursors, or locks.

## Verification

Package tests pin lifecycle cleanup, filesystem seam semantics, subprocess group/stdio/abort behavior, and the package-owned invariant registrations. A credential-gated real Loader composition creates one sandbox, proves FS-write→Bash-read and Bash-write→FS-read in the same remote cwd, proves neither file appears in the host cwd, disposes the composition, and confirms the sandbox id is gone.

## Alternatives considered

**A separate E2B sandbox per capability or tool** — rejected because file and command operations would not share identity or state, defeating the coding-agent use case and multiplying lifecycle ownership.

**Run the entire harness process inside E2B** — rejected because it changes deployment, credential flow, model transport, session durability, plugin loading, and supervision at once. Those questions are independent of proving the provider seams.

**Add E2B-specific Bash, PTY, LSP, persistence, and synchronization packages together** — rejected because Bash already has the required subprocess seam and the other capabilities need separate consumer evidence and lifecycle designs. Their absence is an explicit fidelity boundary, not an incomplete hidden plan.

**Implement filesystem operations through shell commands only** — rejected because that bypasses `ctx.fs` identity, structured errors, version guards, streaming reads, and atomic mutation semantics already consumed by the file tools.

## Consequences

The small composition demonstrates that existing capability seams can move an agent's mutable coding world off-host without changing the loop or model-facing tool packages. `sandboxId` plus pause/leave permits manual state retention for experiments, while kill remains the demo's cleanup policy.

The provider is not interchangeable with the local subprocess backend for every consumer: remote startup cannot synchronously expose a PID, E2B retains complete command output in SDK memory, callback output is not byte-faithful, signal attribution is inferred, and reconnect cannot restore handles. Remote process/spill artifacts accumulate in a retained sandbox. These gaps remain documented POC constraints rather than compatibility shims or new cross-cutting abstractions.
