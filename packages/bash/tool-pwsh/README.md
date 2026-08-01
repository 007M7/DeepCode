# @deepseek-ai/dsh-tool-pwsh

English | [中文](README.zh.md)

The model-facing `pwsh` tool registered over the `ctx.bash` executor seam. Intended for Windows compositions where a PowerShell executor (e.g. `@deepseek-ai/dsh-pwsh-local`) backs `ctx.bash`; the tool contract is PowerShell-dialect: native `C:\...` paths and `$env:NAME` variables. Minimal by design — no background tasks, no sandbox escalation, no persistent shell: this is the "works on my Windows machine" profile until the full bash-tool feature set gets a PowerShell twin.

Requires a loaded executor implementation; the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash', 'systemPrompt']`).

The package root exposes only the Cordis plugin contract (`name`, `inject`, `Config`, `apply`) plus the pure `renderPwshOutput` helper and its result type; execution and presentation remain implementation details covered by same-package tests.

The plugin also contributes the `tool:pwsh` prompt section (order 105): check the `[exit code: N]` marker on every result and investigate failures before moving on.

## Tools

### `pwsh`

| Arg | Type | Notes |
|---|---|---|
| `command` | string (required) | Run via `pwsh -Command`. No state persists between calls — use `workdir`, not `cd`. |
| `description` | string (required) | One-line, active-voice summary of the command (5-10 words), for UI/log display only — no effect on execution. |
| `timeoutMs` | number | Timeout override in milliseconds. The executor applies its configured default and cap. |
| `workdir` | string | Working directory for this call. Defaults to the calling agent's session cwd (`session.header.cwd`) so each session runs in its own workspace; a relative `workdir` is resolved against that same identity. |

`command`, `workdir`, and `timeoutMs` are resolved against the executor's config defaults via `ctx.bash.resolve()` before execution. The workdir default is applied in the tool layer from the calling agent's `session.header.cwd` BEFORE `resolve()` — the per-session cwd must come from `exec.agent`, since N sessions share one executor; only when no session cwd is available does the executor fall back to its own config / `process.cwd()`.

### Managed shell environment

Every call receives a freshly collected trusted `DSH_*` environment. `DSH_HOME` is the absolute Harness home resolved by [`@deepseek-ai/dsh-paths`](../../util/paths/README.md) (`dshHome` config, then ambient `$DSH_HOME`, then `~/.dsh`) and `DSH_SHELL=1` identifies the managed child. Agent calls additionally receive `DSH_SESSION_ID=agent.session.header.id`. The snapshot passes through the dedicated `BashExecRequest.dshEnv` channel; `process.env` is never modified.

Result text contains stdout, an optional `[stderr]` section, then applicable timeout, signal, and exit-code markers: `[timed out after <timeoutMs>ms]`, `[killed by signal: <signal>]`, and `[exit code: N]`, each separated by a newline only when the accumulated text lacks one. Nonzero exit remains a model-interpreted result rather than `isError`. Only infrastructure failures — spawn errors and aborts (`tool call aborted`) — produce `isError`.

The canonical success is `{ kind: 'foreground', ...BashRunResult }` for a completed foreground process. Programmatic consumers use the typed fields without parsing the rendered text.

## UI presentation

The tool owns its `presentCall`/`presentResult` render intent. A call is a `terminal` card carrying command, description, and optional cwd; a completed result is a `generic` card with the rendered output in a `console` fence. These presenters are pure and replay-safe.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains the pwsh guidance below. Scoped tool restrictions can hide the schema without removing this independently registered section.

##### Pwsh guidance

```markdown
Check the [exit code: N] marker on every pwsh result; investigate failures before moving on.
```

#### Token effect

Small fixed input cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the registration scope and prompt text are unchanged. Plugin activation or disposal may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The model sees the generated [`pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh). Agent-scoped tool restrictions can remove the definition for that agent.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while visibility and the tool definition are unchanged. A restriction or config change may invalidate reuse from the first changed token.

### Foreground result

#### What the model sees

The renderer emits the data-dependent stdout tail, then optional `[stderr]` and the stderr tail. Conditional lines are exactly `[timed out after <timeoutMs>ms]`, `[killed by signal: <signal>]`, and `[exit code: <exitCode>]`.

#### Token effect

Zero result tokens before a call. Output is bounded per stream, while each emitted line remains in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Validation and infrastructure failures are normalized as `Error: <message>`. This package's stable messages are `invalid command: expected a non-empty string`, `invalid description: expected a non-empty string`, `invalid timeoutMs: expected a positive number, got <value>`, and `tool call aborted`.

#### Token effect

Only the failing call adds these retained tokens; an aborted call adds no command output.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Foreground-only** — no `run_in_background`; long-running work must stay within the executor timeout or wait for the bash-tool twin.
- **No sandbox escalation** — `sandbox_permissions`/`justification` are absent; a confining composition denies through the executor, and escalation waits for the full twin.
- **PowerShell-dialect contract** — the model must write PowerShell (native paths, `$env:` variables), not bash; there is no dialect translation.
- **Windows-default roadmap deferred** — defaulting Windows hosts to `pwsh` over `bash`, and pwsh TUI/GUI rendering support, are planned separately and deliberately not part of this package yet.
