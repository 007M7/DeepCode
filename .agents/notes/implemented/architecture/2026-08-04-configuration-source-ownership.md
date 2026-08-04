# Agent Note: One ordering for configuration sources, and what a discovered file may not decide

Status: implemented

English | [中文](2026-08-04-configuration-source-ownership.zh.md)

## Problem

`$DSH_HOME/.env` had just [become an ordinary environment layer](2026-08-04-credentials-yaml-and-user-environment-layer.md), which left the harness resolving user-facing values from a flattened `process.env` that could no longer say where a value came from. Three consequences followed.

A key stored through the web page stayed shadowed by an older key in the user's own `.env`, because the credential provider compared "the environment" against its file and the environment now included that file. The migration dead end the split was supposed to remove had simply moved.

An endpoint could be redirected by the project. The invoking directory's `.env` is materialized like every other layer, and a base URL decides where a resolved API key is sent — so a `DEEPSEEK_BASE_URL` written into a workspace the model can edit would send the user's own credential, and the prompts carrying their code, to whatever host that file named. Nothing about the flattened view could distinguish that from the operator exporting the same variable.

And `!!js process.env.X` in the shipped composition made the same value reachable twice: once through the entry config and once through whatever ladder its consumer applied, with the winner decided by layer order rather than by what the value means.

## Decision

**One ordering, four kinds of source.** Every user-facing value resolves in the same order; the domains differ only in which tiers exist.

```text
explicit for this run     per-operation override, CLI argument
> authored by deployment  --config / --config-replace
> this launch's shell     inherited process environment
> product-managed store   settings.yaml, .credentials.yaml
> discovered file         $DSH_HOME/.env
> defaults                schema default, shipped base, provider public default
```

Credentials have no deployment tier (configuration carries a reference, never a value) and no default. Endpoints have every tier. Model selection has CLI, settings, and the shipped default. The earlier proposal ranked a UI-written credential *below* the environment while ranking UI-written settings *above* it; the distinguishing fact is not the domain but who authored the file, so `.credentials.yaml` and `settings.yaml` now sit together, both under the launching shell and both over a discovered `.env`.

**The invoking directory's `.env` decides no credential and no route.** `EnvironmentSnapshot.getFrom(name, sources)` searches only the layers a caller names, and omitting one is a refusal rather than a demotion: the adapters ask for `['process', 'user-env']`, so no future reordering can let a project file back into a decision it was excluded from. A project `.env` remains an ordinary environment layer for ordinary variables.

**A discovered file may not decide how the process starts.** `isBootstrapOnly` rejects, at load and before anything is materialized, any `.env` that sets a variable governing how a process launches (`PATH`, `SHELL`, `NODE_OPTIONS`, `LD_PRELOAD`, …), where code or model-visible instructions load from (the whole `DSH_*` namespace, `HOME`, `XDG_*`), or how the network is reached and trusted (proxy and CA variables). Matching is case-insensitive, so `https_proxy` is not a bypass.

The whole `DSH_*` namespace is denied rather than an audited subset. The harness's own switches — the permission mode, the agents home that holds model-visible skills, the bundled skill root — are exactly what a hostile project would reach for, and a switch added later must not become settable by being forgotten. There is no opt-out: an escape hatch would have to be readable from somewhere, and anything a discovered file could set is the hole itself.

**`packages/util/environment` owns the snapshot**, deliberately as a utility rather than a three-package capability seam. The snapshot is frozen before Cordis starts and injected once by the launcher, so there is no runtime implementation to swap; consumers need types and pure functions, which a `util/` package gives them without depending on a UI package. `environmentOf(ctx)` returns the launcher's snapshot, or the inherited environment as the only layer — an SDK host or bare `cordis.yml` discovered no files, so its single layer really is what it was launched with, and the same trusted lookups keep working there unchanged.

**`verify-config-source-ownership`** keeps both rules: no unregistered `process.env` read under `packages/*/*/src` (26 allowlisted, each with the reason it is a process fact), and no `apiKey`/`baseURL`/`headers` inlined from the environment in shipped Cordis configuration. Removing those inlines is what makes the deployment tier meaningful — with the shipped tree silent on `baseURL`, a present value means a human or deployment set it.

## Consequences

- The web credential form now takes effect against an older key in the user's `.env`; only a key exported in the launching shell still makes it read-only, and the diagnostic says so.
- A `.env` holding `DSH_*`, `PATH`, or a proxy variable fails the launch instead of being applied. Developers keeping switches in a repository `.env` move them to their shell — a deliberate, loud break.
- `--config` is no longer overridable by a stale shell endpoint, so a deployment can pin an enterprise gateway.
- Given up: an endpoint or key in the invoking directory's `.env` no longer applies. Per-project routing is a `--config` overlay or an `export` in that project's shell.
- Not solved: the layers are still materialized into `process.env`, so ordinary project variables continue to reach child processes under the subprocess scrub. Bootstrap variables cannot come from a file at all, which closes the escalation path; a project `.env` setting something like `GIT_SSH_COMMAND` for the tools an agent runs remains possible and is recorded as a limitation on the package.
- Exa and Perplexity still capture their key at load time rather than through the credential seam. They no longer read raw `process.env` — they resolve through the trusted layers — but converting them to per-request seam resolution is separate work.

## Alternatives considered

**Keep the proposal's split ladders (credentials env-over-file, endpoints settings-over-env).** Rejected on its own inconsistency: both arguments — "an export is this run's intent" and "a deployment's file should not be rewritten by a stale shell" — apply to both domains. Sorting by *who authored the source* explains both and produces one table instead of four.

**Let the invoking directory's `.env` supply a credential, ranked below the managed store.** Rejected: with no key stored, a hostile project's key would be used silently, and the account holder reads every prompt sent under it. That is the same exfiltration the endpoint rule exists to prevent, so it takes the same answer.

**Audit an allowlist of `DSH_*` variables a `.env` may set.** Rejected: the list would have to be re-audited on every new switch, and the failure mode of forgetting is silent. Denying the namespace fails safe.

**Rank a bootstrap variable below the process layer instead of rejecting it.** Rejected: `PATH` and `NODE_OPTIONS` have no meaningful "loser" behavior — a user who put one in a `.env` believes it applies, and silently ignoring it is the "my setting has no effect" failure this whole series exists to remove.

**Build the snapshot as a three-package capability seam (`environment` / `environment-local` / consumers).** Rejected as premature: the producer runs before Cordis exists and there is no second implementation to select. The repository rule is to not split preemptively.

**Stop materializing the layers into `process.env`.** Deferred, not rejected: it would keep project variables out of child processes entirely, but it silently breaks any user `--config` tree that reads `!!js process.env.X`. The snapshot is already the authority for everything the harness resolves, so this can land later without changing any ladder.
