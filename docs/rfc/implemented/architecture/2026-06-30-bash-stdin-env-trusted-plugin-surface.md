# RFC: stdin + extra env on the bash seam — a trusted-plugin surface

Status: implemented (accepted 2026-06-30)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

The hooks subsystem runs external hook commands the way Claude Code and Codex do: a hook is a shell command that receives its event payload as **JSON on stdin** and reads context from a handful of **environment variables** (`CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, …). The harness already has a perfectly good command runner behind the `ctx.bash` capability seam ([dsh-bash](../../../../packages/bash/bash) → [dsh-bash-local](../../../../packages/bash/bash-local)), with process-group kills, output truncation/spill, and a credential scrub. Reusing it for hook execution means a hook bridge does not re-implement subprocess plumbing — but the seam had no way to write stdin or set extra env.

The friction is that those two inputs are **dangerous in exactly the way the seam was built to prevent**. [dsh-bash-local](../../../../packages/bash/bash-local)'s `childEnv()` deliberately scrubs `*KEY*`/`*SECRET*`/`*TOKEN*` from the child environment so the harness's own `DEEPSEEK_API_KEY` cannot leak into model-driven command output (see [AGENTS.md](../../../../AGENTS.md) § Defensive patterns, "Never hand untrusted/model output the ambient environment or predictable paths"). An arbitrary-env / arbitrary-stdin capability is the opposite of that guarantee. So the question this RFC answers is not "can we add stdin/env" — it is "who is allowed to use them, and how is that boundary enforced".

## Decision

Add `stdin?: string` and `env?: Record<string, string>` to **both** `BashExecRequest` (the model-/plugin-facing request) and `BashExecSpec` (the resolved spec `run`/`start` act on), and thread them through `dsh-bash-local`: `resolve()` carries them verbatim, `run()`/`start()` pass them to `runBash`, which writes the bytes to the child's stdin and merges the extra env.

Three deliberate choices:

1. **`stdin`/`env` are a TRUSTED-PLUGIN surface, enforced at the consumer, not the seam.** The seam itself imposes no access policy (consistent with how `owner` works — the executor stores but never interprets it). The enforcement lives in the model-facing consumer [dsh-tool-bash](../../../../packages/bash/tool-bash): its `bash` tool builds its `BashExecRequest` from `command`/`workdir`/`timeoutMs`/`signal`/`owner` **only**, and never reads model arguments into `stdin`/`env`. A model that smuggles `env`/`stdin` keys into the tool-call arguments gets them ignored. A regression guard (`tool-bash` "trusted-plugin boundary" tests) drives the real tool with adversarial args and asserts the recorded request carries neither field — and is proven to go red if the consumer ever forwards them. Only in-process plugins (the hooks bridges, native plugins) that construct a `BashExecRequest` directly can set them.

2. **`env` merges AFTER the credential scrub, so a trusted caller's explicit entry always wins** — even a credential-shaped name. This is correct precisely because the scrub's job is narrow: stop the harness's *ambient* `process.env` credentials from leaking into *model-driven* commands. A trusted plugin that explicitly sets a var has taken responsibility for it; the scrub is not a constraint on trusted callers. `childEnv(extra?)` layers `scrub(process.env)` → `ENV_OVERRIDES` (the model-friendly `TERM=dumb` etc.) → `extra`, last-wins.

3. **`stdin`/`env` are required-absent-OK (plain optional) on the resolved spec, NOT required-but-nullable like `owner`.** `owner` is required-but-nullable because a *silently* missing owner yields an unowned, cross-session-readable task — a security footgun that a visible `undefined` guards against. `stdin`/`env` have no such hazard: a missing one means "no stdin / no extra env", which is the safe, ordinary case (every model-driven call). So they stay plain optionals, matching `signal`.

`dsh-bash-local` now ALWAYS spawns stdin as a `'pipe'` and closes it immediately — with the supplied bytes when a trusted plugin set `stdin`, empty otherwise. A closed empty pipe gives a reading child EOF exactly as the previous `'ignore'` (`/dev/null`) did, so the no-stdin path is behavior-equivalent; keeping the `stdio` tuple a literal `['pipe','pipe','pipe']` also preserves the typed `spawn` overload that guarantees non-null `stdout`/`stderr`. A child that exits without reading makes the stdin write fail EPIPE; that error is swallowed (the command's outcome rides on its exit code/output, not the write) so it never crashes the host or rejects `done`.

## Scope: configurable scrub pattern is NOT included

An earlier sketch of this work also proposed making `SENSITIVE_ENV_PATTERN` configurable. Validating against the code, that is **speculative and already subsumed**: `run.ts` documents a configurable whitelist as future work, and the new explicit `env` field — merged after the scrub — already gives a trusted plugin full control, including over credential-shaped vars. There is no current caller that needs to *broaden* the ambient scrub (the hazard runs the other way). Adding a config knob now would be a feature with no consumer, against [AGENTS.md](../../../../AGENTS.md) § "Don't add features beyond what the task requires". If a real workflow ever needs to forward a specific ambient credential, the explicit `env` field is the supported path; a configurable scrub can be reconsidered then.

## Consequences

A hook bridge builds a `BashExecRequest` with the hook's JSON payload as `stdin` and its `CLAUDE_*`/`PLUGIN_ROOT` vars as `env`, and runs it through the same `ctx.bash` everything else uses — no bespoke subprocess code, and the full process-group-kill / truncation / spill machinery for free. The model-facing attack surface is unchanged: the consumer's request-building is the single boundary, guarded by a test that fails if it regresses. The vocabulary addition is documented in [docs/core-data-structures/bash.md](../../../core-data-structures/bash.md) (the `type-equiv` request/spec blocks) and the three bash-package READMEs; the trusted-plugin rule mirrors the existing scrub/predictable-path discipline in [AGENTS.md](../../../../AGENTS.md) § Defensive patterns.
