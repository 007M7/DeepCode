# @deepseek-ai/dsh-sandbox-local

Local implementation of the [`dsh-sandbox`](../sandbox/) seam. It selects and caches one platform runner: Linux prefers a working `bwrap` then Landlock; macOS uses Seatbelt. Multiple candidates are probed in order, while a sole candidate is selected directly.

The package root exports the default and named `LocalSandboxProvider` plugin, `Config`, and its public test-injection seam; platform profile builders stay internal.

Unsupported platforms and unusable runners fail closed with `SANDBOX_UNAVAILABLE`; execution never silently falls through unconfined. Each wrap carries runner-failure signatures so consumers can distinguish a broken sandbox from a command failure. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns selection rationale and profile differences.

Policy is per call; the provider stores only the mechanism and cached runner verdict. Each wrap reports enforcement completeness plus backend-specific denial and runner-failure signatures. `runnerCommand` is an operator assertion of a bwrap-shaped runner and skips probes, but missing or unexecutable commands still fail closed at execution. Because its mechanism is unknown, it carries both Linux denial dialects. `probeTimeoutMs` bounds functional probes. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns selection and failure semantics.

The Seatbelt profile is allow-default with `(deny file-write*)` plus write allow-lists, so exactly the mode's promised file effects are governed: `read-only` grants the `/dev/null` literal alone; `workspace-write` adds the workspace root, `/tmp`, and the per-user darwin temp dir (`os.tmpdir()` — the platform's real temp area for mkstemp-family tools), every root canonicalized because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`). Apple marks the `sandbox-exec` CLI deprecated but ships it on every macOS; the functional probe is what fails closed if that ever changes.

The Landlock launcher comes from the npm package family [`node-addon-landlock-run`](https://www.npmjs.com/package/node-addon-landlock-run) — an entry package (this package's one runtime dependency) plus per-platform binary packages selected by npm's `os`/`cpu` fields, built and released from [its own repository](https://github.com/deepseek-harness/node-addon-landlock-run). The entry package owns the launcher's CLI contract: `launcherPath()` resolution (a host with no platform package yields a never-existing path whose probe fails exactly like an unenforcing kernel), the functional `probe()`, and `grantArgs()` flag spelling — versioned together with the binary, so probe-report parsing can never drift against it. This provider keeps only the policy side: the mode → grants mapping (`landlockProfileArgs`) and the ladder. The consumer path is rehearsed by `tests/packed-install.e2e.ts`: pack THIS package's closure, install into a throwaway consumer with the launcher family coming from the registry, assert the installed binary executable (a stripped mode bit must not masquerade as a non-enforcing kernel), and confine through it under plain `node`.

Every rung has its keyless world-proof (`tests/bwrap.e2e.ts`, `tests/landlock.e2e.ts`, `tests/seatbelt.e2e.ts`), each self-skipping where its runner is absent; CI's `sandbox-e2e` matrix runs all of them against real kernels (bwrap plus one Landlock leg per architecture on Linux, Seatbelt on macOS) and fails on a silent all-skip.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

Consumers: [`@deepseek-ai/dsh-bash-sandbox`](../../bash/bash-sandbox/); see [the acp-agent example](../../../examples/acp-agent/) for the runnable default composition.

## Model Experience

Indirectly, through `dsh-bash-sandbox` and `dsh-tool-bash`, which render this provider's enforcement dialect as the exact `[sandbox: file access denied under <mode> mode]` marker or the [`dsh-sandbox`](../sandbox/README.md) `SANDBOX_UNAVAILABLE` text while keeping runner selection and profiles outside context.

## Known Limitations and Deferred Work

- **Windows has no runner** — `win32` fails closed with `SANDBOX_UNAVAILABLE`; an AppContainer-family backend is deferred.
- **Landlock may be partial** — older supported kernel ABIs confine only the access classes they expose, reported as `enforcement: 'partial'` rather than overstated as full.
- **Seatbelt depends on deprecated `sandbox-exec`** — macOS still ships it, but this provider cannot replace or probe that private policy engine if Apple removes it.
- **Runner selection is cached for the provider lifetime** — installing, removing, or repairing a runner requires reloading the plugin before selection changes.
- **`runnerCommand` is an operator assertion** — a configured custom runner skips functional probes and is assumed to implement the bwrap-shaped profile honestly.
