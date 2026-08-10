# Agent Note: The minimal preset owns the complete RL agent composition

Status: implemented

English | [中文](2026-08-10-minimal-preset-owns-rl-composition.zh.md)

## Problem

The Web surface offered two owners for the Claude SWE-compatible RL agent: a process-wide `core-web.cordis.yml` patch and the per-session `minimal` preset. Once [agent presets](../architecture/2026-08-03-per-session-agent-presets.md) became the agent-composition boundary, the preset's scoped `deployment:persona` shadowed the overlay's corrected global persona with stale coding-agent text. The overlay test mounted no preset, while the preset test booted without the overlay, so neither exercised the composition users selected.

The split also hid other drift. The preset mounted one-shot Bash rather than the [persistent Bash](../feature/2026-07-29-persistent-bash-str-replace-editor.md) used by the RL harness and omitted the RL compaction policy. Keeping both owners makes every future prompt, tool, and policy change a cross-product.

## Decision

The shipped `minimal` preset is the sole RL agent composition. It declares an entry-local PTY registry and local backend, persistent `bash` with the RL environment description and 300-second timeout, `str_replace_editor`, and an entry-local compaction backend. Tool presentation remains a deployment choice. The compaction policy keeps the RL threshold, absolute retention, generation cap, and retry count; model capacity comes from routed adapter metadata because `contextWindow` is no longer a compact-basic config field. The editor accepts no `requireAbsolutePath` setting because absolute paths are its unconditional contract.

The preset persona is exactly `You are a helpful software engineer assistant.` and sets `complete: true`. A complete `PromptSection` participates in ordinary assembly so tools, contexts, variables, and cooperative listeners still resolve; after the `system-prompt/assemble` waterfall, the prompt registry restores a detached copy of that section as the sole system-prompt section. Multiple effective complete sections reject assembly. This final registry constraint prevents harness identity, Web orientation, tool guidance, or an assembly listener from appending prompt text.

The process-wide `core-web.cordis.yml` patch is absent. Browser UI, workspace attachment, persistence, filesystem, subprocess, sandbox, permission, model routing, and other cross-session services remain host-owned. Selecting `minimal` changes one agent's model-facing composition without changing other sessions in the Web process.

## Verification

System-prompt and persona package tests prove final complete-section enforcement, including waterfall mutation and duplicate rejection. The shipped-preset composition test asserts the exact prompt, Bash description, absolute editor schema, and two-tool catalog under the default native presentation. The keyless Web replay sends a real request through a `minimal` agent while global identity, Web surface text, and a test section are registered, then executes two persistent Bash calls to prove environment and cwd state survive and executes the editor through an absolute path.

## Alternatives considered

**Keep `core-web.cordis.yml` as a compatibility patch.** Rejected because a process patch and a session preset are two independent owners for one agent contract; precedence makes either one capable of silently undoing the other.

**Disable every known prompt contributor in the preset.** Rejected because host rows are process-wide and new contributors would reopen the prompt. A final complete-section constraint expresses the negative guarantee at the registry that assembles the prompt.

**Filter sections only with a prepended waterfall listener.** Rejected because another prepended wrapper can run outside it and append after the filter. Enforcement after the complete waterfall has stable final authority.

**Mount PTY services on the Web host.** Rejected because only the minimal agent consumes them. An entry-local `pty` realm gives the services the same lifetime and scope as their sole consumer without publishing a process-global service from a preset.

## Consequences

The RL prompt is fixed rather than environment-overridable, and `minimal` is the only shipped place that states it. The model sees only persistent `bash` and `str_replace_editor`; shell state is per agent and disappears with that agent. The preset pays for its own PTY and compaction service instances, while other presets pay nothing for them. The local persistent-shell backend requires the supported POSIX terminal substrate, so this preset is not a Windows agent surface.
