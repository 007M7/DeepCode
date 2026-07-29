# Agent Note: Persistent Bash and string-replacement editor tools

Status: implemented

English | [中文](2026-07-29-persistent-bash-str-replace-editor.zh.md)

## Problem

Some deployments need a one-call Bash schema whose shell state survives across model turns, while others need a Claude-style `str_replace_editor` independent of their terminal choice. Bundling the two tools or naming them after one benchmark would prevent reuse and blur configuration ownership.

## Decision

`@deepseek-ai/dsh-tool-bash-persistent` consumes `ctx.pty` and registers one `bash(command)` tool. It lazily creates one interactive shell per exact Agent and serializes that owner's calls. Cwd, exported variables, activated environments, functions, and background jobs persist. Random private markers delimit command output. Retained scrollback is paged backward to recover the command's original prefix; a dropped prefix is reported explicitly. Timeout or cancellation closes the shell before another call can reuse uncertain state, and model-visible timeout/exit results disclose that reset. The configurable description defaults to persistence facts only, so network and package-mirror claims remain deployment-owned.

`@deepseek-ai/dsh-tool-str-replace-editor` independently consumes `ctx.fs` and registers `str_replace_editor` with `view`, `create`, `str_replace`, and `insert`. It provides numbered text views, filtered two-level directory listings, unique literal replacement, canonical insertion boundaries, and bounded output. The public schema and failures use only `old_str`; canonical mode requires absolute paths and expands tabs before mutations. Deployments with an intentional session-cwd contract can disable the absolute-path requirement. The plugin can compose with persistent Bash, one-shot Bash, sandboxed Bash, or no shell.

`dsh-system-prompt` accepts `includeHarnessIdentity: false`, while `dsh-agent-spine-demo` forwards that setting and accepts `toolBash: false`. A deployment can therefore own an exact persona and replace the spine's native Bash without duplicate prompt or tool registrations. Existing defaults remain unchanged.

Both plugins are included in the Python runtime closure. The persistent Bash closure also includes the PTY service/local backend and the sandbox services required by that backend. Because `node-pty` executes a native `spawn-helper`, each packaged runtime executable ships with an architecture-matched `-spawn-helper` sibling. A pinned `node-pty` patch resolves that sibling only when present (or when `DSH_NODE_PTY_SPAWN_HELPER` explicitly selects one), preserving upstream lookup in ordinary Node runs; the executable and runtime-wheel builders fail before publication when the helper is absent, mismatched, or not executable.

## Alternatives considered

**One combined compatibility plugin.** Rejected because neither tool requires the other and the combined name would tie reusable capabilities to one benchmark.

**Reuse one-shot Bash.** Rejected because `bash -c` cannot preserve cwd or environment state across calls.

**Expose terminal management tools.** Rejected because open/send/read/close is a different model action space from one persistent `bash` call.

**Modify native read/write/edit.** Rejected because it would distort their general-purpose contracts instead of adding an independently composable editor.

## Consequences

Profiles can reproduce an external agent by configuring persona and descriptions while the underlying packages remain general. Persistent Bash requires an owning Agent and real PTY backend. Shell exit, timeout, or cancellation loses state. The editor delegates security and mutation policy to the mounted filesystem stack. Runtime-wheel consumers still need no Node installation, but the wheel now contains a main executable plus its private native helper rather than one physical file.
