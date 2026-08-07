# dsh-environment

English | [中文](README.zh.md)

This run's environment as one immutable snapshot that remembers **which layer supplied each value**. Consumers resolve user-facing values against it instead of `process.env`, because the layers are not equally trusted and a flattened view cannot tell them apart.

| Layer | Source id | What it is |
|---|---|---|
| Inherited process environment | `process` | What the launching shell, CI job, or container passed in — this run's explicit intent |
| `<invocation cwd>/.env` | `project-env` | The project the harness was launched in, which the product trusts to configure its own agent |
| `$DSH_HOME/.env` | `user-env` | The user's own machine-level defaults |

Values do also reach `process.env` — a user's `--config` tree and third-party libraries read it — but that flattened view is not the authority for anything the harness resolves.

## Resolving

`get(name)` searches every layer, most trusted first. `getFrom(name, sources)` searches only the named layers without changing that trust order.

**Omitting a layer is a refusal, not a demotion** — a caller that must never accept a layer leaves it out of the list, so no future reordering can let it back in. The provider adapters name all three, because the product trusts the project it runs in; the mechanism exists for the decisions where that is not true.

Names match the way the platform matches them: exactly on POSIX, case-insensitively on Windows. A case-sensitive lookup there would rank the wrong layer — a shell's `deepseek_api_key` and a project `.env`'s `DEEPSEEK_API_KEY` are one variable to the OS, and treating them as two would let the project win.

```ts
import type { Context } from 'cordis'
import { environmentOf } from '@deepseek-ai/dsh-environment'

declare const ctx: Context
const endpoint = environmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value
```

`environmentOf(ctx)` returns the launcher's snapshot when the product CLI booted the tree, and otherwise the inherited environment as the only layer. That fallback does not weaken the rules: an SDK host or a bare `cordis.yml` discovered no files, so everything it has really is the environment it was launched with.

## Bootstrap variables

`isBootstrapOnly(name)` names the variables only the inherited environment may set. The launcher rejects a `.env` that declares one, before applying anything.

Trusting a project to configure the agent's work is not the same as letting it change the harness. A bootstrap variable decides **how a process launches** (`PATH`, `SHELL`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`), **what code a runtime executes before the program it was asked to run** (`BASH_ENV` and its per-language siblings — `PERL5OPT`, `PYTHONSTARTUP`, `RUBYOPT`, `JAVA_TOOL_OPTIONS` — plus the Git hook commands), **where model-visible instructions load from** (the whole `DSH_*` namespace, `HOME`, `XDG_*`), or **how the network is reached and trusted** (proxy and CA variables). Matching is case-insensitive, so `https_proxy` is not a bypass.

These take effect with no user action, before any turn, outside the permission policy and the sandbox: `DSH_PERMISSION_MODE` would switch off the approvals that make trusting a project meaningful, and `BASH_ENV` runs a file of the project's choosing on every `bash -c` the bash tool issues.

The whole `DSH_*` namespace is denied rather than an audited subset: the harness's own switches — the permission mode, the agents home, the bundled skill root — are exactly what a hostile project would want, and a switch added later must not become settable by forgetting to list it.

## Known Limitations and Deferred Work

- **The snapshot is not a subprocess boundary** — every layer is also materialized into `process.env`, so ordinary project variables reach child processes under [`dsh-subprocess`](../../subprocess/subprocess/README.md)'s scrub. That is intended for ordinary variables; the code-loading hooks that would abuse it are rejected at load instead, and the deny list is the thing to extend when a new runtime hook appears.
- **No per-workspace layer** — the project layer is the *invoking* directory, fixed at launch. A workspace selected later in the Web UI contributes nothing, deliberately: following it would let a model's own workspace change the harness environment mid-session.
