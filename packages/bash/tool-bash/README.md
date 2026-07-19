# @deepseek-ai/dsh-tool-bash

The model-facing `bash` tool registered over the `ctx.bash` executor seam. Foreground execution stays behind that seam; a background process handle is registered with the generic `ctx.tasks` runtime and controlled through `task_output`, `task_list`, and `task_kill` from `@deepseek-ai/dsh-tool-tasks`.

Requires a loaded executor implementation (e.g. `@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash', 'systemPrompt']`).

The package root exposes only the Cordis plugin contract (`name`, `inject`, `Config`, `apply`); result rendering and background-process adaptation remain implementation details covered by same-package tests.

The plugin also contributes the `tool:bash` prompt section (order 105): check the `[exit code: N]` marker on every result and investigate failures before moving on.

## Tools

### `bash`

| Arg | Type | Notes |
|---|---|---|
| `command` | string (required) | Run via `bash -c`. No state persists between calls — use `workdir`, not `cd`. |
| `description` | string (required) | One-line, active-voice summary of the command (5-10 words), for UI/log display only — no effect on execution. |
| `timeoutMs` | number | Timeout override in milliseconds. The executor applies its configured default and cap. |
| `workdir` | string | Working directory for this call. Defaults to the calling agent's session cwd (`session.header.cwd`) so each session runs in its own workspace; a relative `workdir` is resolved against that session cwd. |
| `run_in_background` | boolean | Return a task id immediately; no timeout applies. |
| `sandbox_permissions` | string enum | ADVERTISED ONLY when the mounted executor sandboxes (`ctx.bash.sandboxMode` reports a confining default): the wider mode a denied command needs, from the closed target vocabulary `workspace-write`/`danger-full-access` (never cut down to the executor's default — the effective mode is per-session; strict widening is checked at execution against it, and a non-widening request fails without prompting anyone). |
| `justification` | string | Required together with `sandbox_permissions` (each without the other is a validation error): one sentence for the user explaining why this exact command needs the wider access. |

`command`, `workdir`, and `timeoutMs` are resolved against the executor's config defaults via `ctx.bash.resolve()` before execution, so the executor seam (`BashExecSpec`) receives explicit `workdir`/`timeoutMs` values. The workdir default is applied in the tool layer (from the calling agent's `session.header.cwd`) BEFORE `resolve()` — the per-session cwd must come from `exec.agent`, since N sessions share one executor; only when no session cwd is available does the executor fall back to its own config / `process.cwd()`.

### Managed shell environment

Every foreground and background model bash call receives a newly collected trusted `DSH_*` environment. `DSH_HOME` is the absolute Harness home resolved by [`@deepseek-ai/dsh-home`](../../util/home/README.md) (`dshHome` config, then ambient `$DSH_HOME`, then `~/.dsh`) and `DSH_SHELL=1` identifies the managed child. Agent calls additionally receive `DSH_SESSION_ID=agent.session.header.id`; when the active persistence seam locates a JSONL artifact they also receive `DSH_SESSION_JSONL=<absolute target path>`. The JSONL path is a location hint: it may not exist before the first flush or contain the current buffered turn, and it is not an authorization credential.

`ctx.bashEnv` owns collection. Other plugins can register an effect-scoped contributor with a stable name, declared keys/descriptions, and `resolve(execution: ToolExecution)`; duplicate ownership and undeclared runtime keys fail loudly, while `list()` enumerates declarations without executing providers. Harness built-ins reserve `DSH_HOME`, `DSH_SHELL`, and `DSH_SESSION_ID`; tool-bash's persistence translator owns `DSH_SESSION_JSONL` by reading the backend-neutral `sessionPersistence.locate()` seam.

```ts
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tool-bash'

export const inject = ['bashEnv']

export function apply(ctx: Context): void {
  ctx.bashEnv.register({
    name: 'deployment-region',
    variables: { DSH_DEPLOYMENT_REGION: { description: 'Current deployment region.' } },
    resolve: execution => execution.agent === undefined ? {} : { DSH_DEPLOYMENT_REGION: 'cn-north' },
  })
}
```

The overlay is computed from the current `ToolExecution` and passed through the dedicated `BashExecRequest.dshEnv` channel. The local executor removes all inherited `DSH_*` before merging that snapshot, so nested harnesses and concurrent parent/child agents cannot leak stale identities. `process.env` is never modified. The tool description teaches the generic `$DSH_*` convention rather than naming persistence-specific variables or adding a permanent system-prompt section.

Result text contains stdout, an optional `[stderr]` section, then applicable sandbox-denial, timeout, signal, exit-code, and truncation markers. Timeout is reported independently of final exit status; nonzero exit remains a model-interpreted result rather than `isError`. Truncation links a safe complete spill file or reports it unavailable. Only infrastructure failures such as spawn errors and aborts produce `isError`.

When `run_in_background` is true, this plugin preflights `ctx.tasks.start()` before spawning, registers the calling agent as owner, and adapts the returned `BashProcess` handle into generic cancel/done/incremental-output hooks. The task runtime owns ids, cross-session isolation, completion notices, waiting, and disposal cleanup; this plugin only maps bash exit/sandbox facts into task output and outcome detail. `enableRunInBackground: false` removes the parameter and rejects a forced background call at execution time.

## UI presentation

The tool owns its `presentCall`/`presentResult` render intent. A foreground call is a terminal card carrying command, description, cwd, raw output, and parsed exit status. A background start is a generic execute card because it returns only a task id; the generic `task_*` tools own their own cards. These presenters are pure and replay-safe.

## The tool builds its request from named args only

The `BashExecRequest` seam carries optional `stdoutMaxBytes`, `stdin`, ordinary `env`, and managed `dshEnv`, used by trusted in-process plugins and this tool's environment registry. The model-facing tool exposes none of `stdoutMaxBytes`, `stdin`, or `env`: it builds requests from named command/workdir/timeout/signal/sandbox fields plus the registry-collected `dshEnv`. Extra model keys are ignored and cannot replace managed values. Shell syntax provides equivalent command-level behavior, while the local executor scrubs ambient credentials and stale `DSH_*` values. See the [stdin/env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Permissions and escalation

Commands run with the executor's full authority unless a sandboxing executor ([`dsh-bash-sandbox`](../bash-sandbox/)) confines them — the deny-only sandbox reports denials as result facts, rendered here as the denial marker; per-call allow/deny/ask policy is the `tools/pre-execute` waterfall (see docs/architecture.md).

Escalating bash calls resolve `ctx.approval` before execution. `allowed-once` applies the requested mode only to that call; rejection, cancellation, unavailability, or missing approval context executes nothing and returns a distinct error. On a real denial, the model may retry the same command once in the same turn with the narrowest sufficient mode and justification; the approval prompt itself is the consent step. Escalation is never speculative, and a disabled or rejected approval is final. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns the rationale.

## Per-session mode switching

For sandboxing executors, each call resolves mode as one-shot escalation, then session override, then executor default. Non-sandboxing and agent-less calls carry no session override. Neither the prompt nor a switch notice announces the standing mode; denial results report the effective mode when the boundary matters. See the [`dsh-bash` fold](../bash/README.md) and [sandbox switching contract](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains the bash guidance below. A sandboxing executor adds no mode statement or switch notice. Scoped tool restrictions can hide the schemas without removing this independently registered section.

##### Bash guidance

```markdown
Check the [exit code: N] marker on every bash result; investigate failures before moving on.
```

#### Token effect

Small fixed input cost per request while the plugin is active, unchanged by sandbox mode or mode switches.

#### KV Cache effect

Prefix-stable while the registration scope and prompt text are unchanged. Plugin activation or disposal may invalidate reuse from this prompt section; sandbox mode switches do not.

### Tool schemas

#### What the model sees

The model sees the generated [`bash` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash). `run_in_background` appears only when this producer enables it; `sandbox_permissions` and `justification` appear only when the mounted executor advertises sandboxing. Agent-scoped tool restrictions can remove the definition for that agent.

#### Token effect

Fixed schema cost on every request where the tools are visible; sandbox support adds the escalation fields and its conditional description paragraph.

#### KV Cache effect

Prefix-stable while visibility, background support, and executor sandbox capabilities are unchanged. A restriction, config change, or executor change may invalidate reuse from the first changed tool definition.

### Foreground result

#### What the model sees

The renderer emits the data-dependent stdout tail, then optional `[stderr]` and the stderr tail. With no output it emits exactly `(no output)`. Conditional lines are exactly `[output truncated; full output: <path-or-(unavailable)>]`, `[sandbox: file access denied under <mode> mode]`, `[timed out after <timeoutMs>ms]`, `[killed by signal: <signal>]`, and `[exit code: <exitCode>]`; the sandbox escalation and runner-failure lines are quoted in [`dsh-bash-sandbox`](../bash-sandbox/README.md).

#### Token effect

Zero result tokens before a call. Output is bounded per stream, while each emitted line remains in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background task context and results

#### What the model sees

Start returns exactly `started background task <taskId>`. This producer supplies incremental process output, optional `[some output was dropped from memory; full output: <paths-or-(unavailable)>]`, sandbox facts, and terminal detail such as `exit code: <exitCode>` or `signal: <signal>` to the generic task runtime. [`dsh-tool-tasks`](../../tasks/tool-tasks/README.md) owns the visible status line, completion notice, listing, and cancellation response.

#### Token effect

The start acknowledgement is small and retained; collected output is data-dependent and bounded by the executor's stream buffers. Consuming reads do not repeat prior output.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Validation and policy failures are normalized as `Error: <message>`. This package's stable messages are `invalid command: expected a non-empty string`, `invalid description: expected a non-empty string`, `invalid timeoutMs: expected a positive number, got <value>`, `invalid escalation: sandbox_permissions requires a justification`, `invalid escalation: justification is only valid together with sandbox_permissions`, `invalid justification: expected a non-empty sentence`, `background execution is disabled for this bash tool`, `background tasks unavailable: load @deepseek-ai/dsh-tasks and @deepseek-ai/dsh-tool-tasks`, `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`, `sandbox escalation to "<mode>" is not strictly wider than this call's current "<mode>" mode`, the approval-availability/rejection/cancellation variants, and `command aborted`.

#### Token effect

Only the failing call adds these retained tokens; a rejected escalation does not add command output because the command does not run.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Replay exit pills parse from result text** — output whose final line happens to be exactly `[exit code: N]` / `[killed by signal: …]` shows a wrong pill on session replay; a display-only known residual.
- **The `bash` tool opts out of `timeout-policy` budgets** — it keeps the executor-owned `BASH_TIMEOUT` path, per [the tool-call timeout-policy RFC](../../../docs/rfc/implemented/architecture/2026-07-07-tool-call-timeout-policy.md).
- **Background processes have no executor timeout** — callers must use `task_kill`, or rely on owner/service disposal, when work no longer matters.
