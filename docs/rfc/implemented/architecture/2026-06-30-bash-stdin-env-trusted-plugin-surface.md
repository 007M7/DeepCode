# RFC: stdin + extra env on the bash seam

Status: implemented

## Problem

The hooks subsystem runs external hook commands the way Claude Code and Codex do: a hook is a shell command that receives its event payload as **JSON on stdin** and reads context from a handful of **environment variables** (`CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, …). The harness already has a perfectly good command runner behind the `ctx.bash` capability seam ([dsh-bash](../../../../packages/bash/bash) → [dsh-bash-local](../../../../packages/bash/bash-local)), with process-group kills, output truncation/spill, and a credential scrub. Reusing it for hook execution means a hook bridge does not re-implement subprocess plumbing — but the seam had no way to write stdin or set extra env. This RFC adds those two inputs.

`stdin` and `env` do not create a new model capability because ordinary shell syntax already supplies both. Ambient credentials are protected by `dsh-bash-local`'s child-environment scrub, not by hiding these seam fields; model tool arguments are static JSON and do not expand shell variables. The fields therefore serve trusted in-process callers, such as hook bridges, that need to pass structured input and `CLAUDE_*` variables without embedding them in model-visible shell text. See [defensive-patterns.md](../../../defensive-patterns.md) for the ambient-environment rule.

## Decision

Add `stdin?: string` and `env?: Record<string, string>` to **both** `BashExecRequest` (the model-/plugin-facing request) and `BashExecSpec` (the resolved spec `run`/`start` act on), and thread them through `dsh-bash-local`: `resolve()` carries them verbatim, `run()`/`start()` pass them to `runBash`, which writes the bytes to the child's stdin and merges the extra env.

Three deliberate choices:

1. **The model-facing tool omits `stdin` and `env`.** Shell syntax already covers those needs, so duplicate parameters would add surface without authority separation. The tool builds requests only from declared model arguments, signal, and owner; trusted in-process callers may set the seam fields directly.

2. **`env` merges AFTER the credential scrub, so an explicit caller entry always wins** — even a credential-shaped name. This is correct because the scrub's job is narrow: stop the harness's *ambient* `process.env` credentials from leaking into a spawned command. A caller that explicitly sets a var has named a value it already holds (not the ambient secret), so the scrub is not a constraint on it. `childEnv(extra?)` layers `scrub(process.env)` → `ENV_OVERRIDES` (the model-friendly `TERM=dumb` etc.) → `extra`, last-wins.

3. **`stdin`/`env` are required-absent-OK (plain optional) on the resolved spec, NOT required-but-nullable like `owner`.** `owner` is required-but-nullable because a *silently* missing owner yields an unowned, cross-session-readable task — a security footgun that a visible `undefined` guards against. `stdin`/`env` have no such hazard: a missing one means "no stdin / no extra env", which is the safe, ordinary case (every model-driven call). So they stay plain optionals, matching `signal`.

`dsh-bash-local` creates a stdin pipe only when bytes are supplied; otherwise fd 0 remains `/dev/null`, preserving prior behavior. It writes the bytes and closes the pipe. `EPIPE` from a child that exits without reading is ignored because command exit and output determine the result.

## Alternatives considered

**Configurable ambient-secret scrub.** Rejected as speculative. Trusted callers can explicitly provide required values after the scrub without weakening the default ambient protection.

## Consequences

Hook bridges pass JSON payloads and hook-specific variables through the existing bash seam, retaining its process-group, truncation, and spill behavior. The model surface remains unchanged, and the bash tool remains the sole owner of model-call request construction. The vocabulary lives in [the bash data-structure reference](../../../core-data-structures/bash.md).
