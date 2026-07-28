# e2b/ — E2B remote runtime family

English | [中文](README.zh.md)

An experimental provider-composition POC that places the filesystem and managed subprocess world in one E2B Linux sandbox. The shared owner is separate from the capability adapters so every remote provider awaits the same sandbox identity and lifecycle.

| Package | ctx key | Role |
|---|---|---|
| [`e2b`](e2b/README.md) (`@deepseek-ai/dsh-e2b`) | `ctx.e2b` | Create or reconnect one sandbox, create its working/runtime directories, expose the shared SDK handle, and apply the configured kill/pause/leave disposition |
| [`fs-e2b`](../fs/fs-e2b/README.md) (`@deepseek-ai/dsh-fs-e2b`) | `ctx.fs` | Implement the filesystem seam over E2B Filesystem APIs |
| [`subprocess-e2b`](../subprocess/subprocess-e2b/README.md) (`@deepseek-ai/dsh-subprocess-e2b`) | `ctx.subprocess` | Implement managed process groups, stdio projection, and remote spill files over E2B Commands |

The existing [`dsh-bash-local`](../bash/bash-local/README.md) needs no E2B-specific fork: it already delegates process mechanics to `ctx.subprocess`, so replacing that provider places Bash in the same remote world as `ctx.fs`. This boundary does not move the harness process, Cordis objects, model calls, agent/session state, session persistence, skills, or E2B SDK buffers. The [decision record](../../.agents/notes/implemented/feature/2026-07-27-e2b-remote-runtime-poc.md) owns the POC boundary and rejected expansion.
