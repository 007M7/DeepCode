---
name: editing-cordis-compositions
description: Use when creating or changing a Cordis composition for this harness — writing or editing an agent preset, adding or removing a plugin row, deciding whether something belongs to the host composition or to one session, or diagnosing a row that mounted but contributed nothing.
---

# Editing Cordis compositions

Every capability in this harness is a plugin row in a `cordis.yml`. There is no separate configuration language: changing what an agent can do means changing which rows are composed for it.

## Decide the plane first

Two planes, and the choice is not about how "agent-related" something feels — it is about whether the thing must be shared.

**Host composition.** The registries themselves (`tools`, `systemPrompt`, `agents`, `agent-loop`, `sessions`), anything crossing sessions (persistence, session query, storage, settings, credentials, telemetry), the sandbox and approval stack, the model route, and the subagent registry with its spawn/fork backends. One instance for the process.

**Agent preset.** What one session contributes to those registries: its tool plugins, its persona and prompt sections, its compaction policy. One instance per session, mounted under that session's scope and unwound with it.

**A service with a consumer outside the agent plane cannot move into a preset.** `subagents` is the worked example: the registry answers cross-session queries for the host api-proxy, so a per-session copy both starves that host row — it waits forever for a service nothing provides — and collides on the second session, since a provider name registers once. The preset contributes the delegation *tools*; the registry and its backends stay host-side.

A preset is a directory holding one `agent.cordis.yml`. The shipped ones live beside the deployment's composition; locally authored ones live under `$DSH_HOME/.agent-presets/<name>/`.

## The rule that catches people

**A row that publishes a service may not sit loose in a preset.** Registering a service without an isolate realm puts it in the process-global realm, so the second session mounting that preset collides with the first. The mount rejects it rather than letting the collision surface later.

Whether a row publishes a service is not visible from its name. `tool-bash` reads like a tool but provides `bashEnv`. Check the package's README, or mount the preset and read the rejection — it names the offending service.

When a preset genuinely owns a service, wrap the provider **and every consumer that reaches it** in one group carrying an `isolate` realm:

```yaml
- id: skills
  name: cordis:group
  group: true
  isolate:
    skills: true
  config:
    - id: skill
      name: '@deepseek-ai/dsh-skill'
    - id: skill-local
      name: '@deepseek-ai/dsh-skill-local'
    - id: tool-skill
      name: '@deepseek-ai/dsh-tool-skill'
```

`true` means a realm private to each mounting session. A string label instead pools one instance across every subtree naming that label — use it only for something genuinely expensive to duplicate.

A consumer left outside the group resolves the host's registry, which the preset did not populate, and then contributes nothing. That is the quietest failure here: the mount succeeds and a tool is simply missing.

## Verifying a change

Read the live runtime with `cordis_inspect` — it reports the services, the plugin fibers, and the registered tools as they actually are, which is the only reliable check that a row did what its name suggests.

After editing a preset, start a new session on it and confirm the tool list is what you intended. A preset is read at session creation, so an edit never affects a session already running; the file is never written back either, so your composition is exactly what you wrote.

`cordis_mount` evaluates JavaScript against the live runtime and disappears on restart. It is for probing, not for shipping a capability: a capability belongs in a composition file.

## What not to move into a preset

`agent-loop` registers the one agent factory and throws on a second. The registries own the per-session layering and cannot themselves be per-session. Session persistence must stay host-side or the session list fragments. The sandbox, approval, and permission rows are a deliberate boundary: a preset is exactly as privileged as the plugins it names, so letting one relax its own confinement would defeat the confinement.
