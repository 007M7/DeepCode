# dsh-environment

English | [中文](README.zh.md)

This run's environment as one immutable snapshot that remembers **which layer supplied each value**. Consumers resolve user-facing values against it instead of `process.env`, because the layers are not equally trusted and a flattened view cannot tell them apart.

| Layer | Source id | What it is |
|---|---|---|
| Inherited process environment | `process` | What the launching shell, CI job, or container passed in — this run's explicit intent |
| `<invocation cwd>/.env` | `project-env` | Whatever the project directory happens to contain; a model working in that workspace can write it |
| `$DSH_HOME/.env` | `user-env` | The user's own machine-level defaults |

Values do also reach `process.env` — a user's `--config` tree and third-party libraries read it — but that flattened view is not the authority for anything the harness resolves.

## Resolving

`get(name)` searches every layer, most trusted first. `getFrom(name, sources)` searches only the layers the caller trusts.

**Omitting a layer is a refusal, not a demotion.** A base URL decides where a resolved API key is sent, so the LLM adapters ask for `['process', 'user-env']`: no future reordering can let a project file redirect a credential, because that layer is never consulted at all.

```ts
import type { Context } from 'cordis'
import { environmentOf } from '@deepseek-ai/dsh-environment'

declare const ctx: Context
const endpoint = environmentOf(ctx).getFrom('DEEPSEEK_BASE_URL', ['process', 'user-env'])?.value
```

`environmentOf(ctx)` returns the launcher's snapshot when the product CLI booted the tree, and otherwise the inherited environment as the only layer. That fallback does not weaken the rules: an SDK host or a bare `cordis.yml` discovered no files, so everything it has really is the environment it was launched with.

## Bootstrap variables

`isBootstrapOnly(name)` names the variables only the inherited environment may set. The launcher rejects a `.env` that declares one, before applying anything.

A bootstrap variable decides **how a process launches** (`PATH`, `SHELL`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`), **where code or model-visible instructions load from** (the whole `DSH_*` namespace, `HOME`, `USERPROFILE`, `XDG_*`), or **how the network is reached and trusted** (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`). Matching is case-insensitive, so `https_proxy` is not a bypass.

The whole `DSH_*` namespace is denied rather than an audited subset: the harness's own switches — the permission mode, the agents home, the bundled skill root — are exactly what a hostile project would want, and a switch added later must not become settable by forgetting to list it.

## Known Limitations and Deferred Work

- **The snapshot is not a subprocess boundary** — every layer is also materialized into `process.env`, so ordinary project variables still reach child processes under [`dsh-subprocess`](../../subprocess/subprocess/README.md)'s scrub. Bootstrap variables cannot come from a file at all, but a project `.env` can still set, say, `GIT_SSH_COMMAND` for the tools an agent runs.
- **No per-workspace layer** — the project layer is the *invoking* directory, fixed at launch. A workspace selected later in the Web UI contributes nothing, deliberately: following it would let a model's own workspace change the harness environment mid-session.
