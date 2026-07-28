# @deepseek-ai/dsh-e2b

English | [中文](README.zh.md)

Shared lifecycle owner for one E2B sandbox. The filesystem and subprocess adapters inject `ctx.e2b`, await its single SDK handle, and therefore inhabit the same remote Linux working tree and process world. The package pins `e2b@2.29.1`; the [family map](../README.md) lists the opt-in composition.

## Configuration

```yaml
- id: e2b
  name: '@deepseek-ai/dsh-e2b'
  config:
    cwd: /home/user/workspace
    timeoutMs: 300000
    onTimeout: pause
    onDispose: kill

- id: subprocess-e2b
  name: '@deepseek-ai/dsh-subprocess-e2b'

- id: fs-e2b
  name: '@deepseek-ai/dsh-fs-e2b'
```

`apiKey` is optional and otherwise reads `E2B_API_KEY`; the key configures the host SDK connection and is never installed in the sandbox. `cwd` defaults to `/home/user/workspace` and must be an absolute POSIX path. `timeoutMs` defaults to five minutes. `onTimeout` is `pause` by default and accepts `pause | kill`; it applies only when this service creates a sandbox. Pause-on-timeout enables E2B auto-resume so the shared SDK handle wakes on its next operation. `onDispose` defaults to `kill` and accepts `kill | pause | leave`.

Set `sandboxId` to reconnect a running or paused sandbox instead of creating one. E2B resumes a paused sandbox during connect; `template` is creation-only and cannot accompany `sandboxId`. Omitting `template` uses E2B's default base template.

## Lifecycle and ownership

Construction starts one create/connect operation. Before resolving `getSandbox()`, the service creates `cwd` and the private `cwd/.dsh-e2b` adapter-state directory, verifies that the reserved path is a real directory rather than a symlink or another file type, then sets it to mode `0700`. `sandboxId` resolves to a branded `E2BSandboxId` after setup.

Disposal first prevents new handle acquisition, then awaits setup and applies exactly one configured disposition. A `SandboxNotFoundError` means a kill-on-timeout sandbox is already quiescent; every other disposition failure rejects teardown. A newly created sandbox is killed when initial directory setup fails; a reconnected sandbox is not killed on setup failure because the service did not create it. Provider plugins must load after this owner and dispose before it.

`pause` and `leave` retain remote filesystem and adapter artifacts for a later `sandboxId` connection, but a later harness process receives only a new SDK handle. The subprocess service still fulfills its seam contract by terminating managed groups before owner disposal; neither disposition recovers prior process objects, output cursors, or in-memory adapter locks.

## Model Experience

None, as this shared runtime owner registers no model-visible context; provider adapters and their consumers own any rendered effects.

#### KV Cache effect

No direct invalidation; this package does not contribute request tokens.

## Known Limitations and Deferred Work

- **This is not a whole-harness runtime** — Cordis services, agent/session state, session logs, LLM requests, skills, and SDK-side buffers stay in the host process.
- **Retained sandboxes do not restore host handles** — reconnect preserves remote files and adapter artifacts, but cannot reconstruct subprocess handles, stream cursors, or mutation locks; managed subprocesses terminate when their service disposes.
- **No deployment platform is configured** — templates, volumes, snapshots, network policy, host-workspace synchronization, and sandbox discovery are outside this POC.
- **`cwd` is a resolution convention, not containment** — adapters and commands can address other sandbox paths; E2B network access also retains the template's policy.
