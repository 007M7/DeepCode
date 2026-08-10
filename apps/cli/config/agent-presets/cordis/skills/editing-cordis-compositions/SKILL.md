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

A preset is a directory holding one `agent.cordis.yml`, optionally beside a `preset.yml` carrying display metadata — `name` and `description` (and, for shipped presets, a roster `order`). Write the metadata too: a preset without it shows up in every picker as its bare directory name. The shipped presets live beside the deployment's composition; locally authored ones live under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<name>/`.

## Authoring a preset

1. **Start from a copy.** Read a shipped composition close to what you want (the `standard` preset is the full coding agent) and copy its whole directory into `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/` — the id must be lowercase letters, digits, and hyphens, because it becomes the directory name. A composition written from scratch usually forgets a group realm or a consumer row; a copy starts loadable.
2. **Expect the file sandbox.** The preset root lies outside the session workspace, so under the default `workspace-write` policy the first write is denied. Retry that exact command once with `sandbox_permissions` escalation and a short justification — the user sees and approves it. Batch your writes (one heredoc per file) rather than escalating many small commands.
3. **Rewrite `preset.yml`**: give the copy its own `name` and `description`, and drop any `order` the source declared — that field sorts the shipped roster.
4. **Edit `agent.cordis.yml`** row by row, keeping the plane rule and realm rule above.

### Native product subagents

Codex and Claude Code providers already live in the host composition. A preset chooses either product by contributing the same ordinary delegation-tool row used for spawn and fork; never move a product provider into the preset and never add a product-specific settings field.

Copy these disabled templates from a shipped full preset and remove `disabled` only for the products the user requested:

```yaml
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex
    toolName: subagent_codex
    enableRunInBackground: false
    maxDepth: provider-managed

- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: claude-code
    toolName: subagent_claude_code
    enableRunInBackground: false
    maxDepth: provider-managed
```

The two rows are independent. Leaving both disabled preserves the copied preset, enabling one exposes only that product tool, and enabling both exposes both. The host must provide `codex` or `claude` on `PATH`; the preset does not install, authenticate, select a model for, or probe either product.

The shipped preset directories are off-limits: never edit or delete them, and never escalate the sandbox to reach them, even when a change there looks quicker — an upgrade overwrites the install, and corrupting the `cordis` preset disables preset authoring itself. Locally authored presets under the user root are yours to create, edit, and delete.

## The rule that catches people

**A row that publishes a service may not sit loose in a preset.** Registering a service without an isolate realm puts it in the process-global realm, so the second session mounting that preset collides with the first. The mount rejects it rather than letting the collision surface later.

Whether a row publishes a service is not visible from its name. `tool-bash` reads like a tool but provides `bashEnv`. Check the package's README, or mount the preset and read the rejection — it names the offending service.

When a preset genuinely owns a service, wrap the provider **and every consumer that reaches it** in one group carrying an `isolate` realm:

```yaml
- id: tasks
  name: cordis:group
  group: true
  isolate:
    tasks: true
  config:
    - id: tasks-local
      name: '@deepseek-ai/dsh-tasks-local'
    - id: tool-tasks
      name: '@deepseek-ai/dsh-tool-tasks'
```

`true` means a realm private to each mounting session. A string label instead pools one instance across every subtree naming that label — use it only for something genuinely expensive to duplicate.

A consumer left outside the group resolves the host's registry, which the preset did not populate, and then contributes nothing. That is the quietest failure here: the mount succeeds and a tool is simply missing.

Registry-shaped host capabilities need no realm at all: the host `tools` and `skills` registries are layered per scope, so rows like `skill-local` and `tool-skill` sit loose in the preset and their registrations file into this preset's layer automatically — the agent's catalog merges them with whatever the deployment registered globally.

## Verifying a change

Read the live runtime with `cordis_inspect` — it reports the services, the plugin fibers, and the registered tools as they actually are, which is the only reliable check that a row did what its name suggests. Note it shows THIS session's composition: a preset you just wrote is not mounted anywhere until a session starts on it.

To check a preset you authored, re-read the files you wrote and walk the shape: a top-level YAML list, every row a map with a `name`, every group carrying its own list, service-publishing rows behind an `isolate` realm. The settings page's preset roster runs the same shape check and marks an unloadable preset broken in red — point the user there, and ask them to start a session on the new preset to confirm the tool list; you cannot start one yourself.

`cordis_mount` evaluates JavaScript against the live runtime and disappears on restart. It is for probing, not for shipping a capability: a capability belongs in a composition file.

## What not to move into a preset

`agent-loop` registers the one agent factory and throws on a second. The registries own the per-session layering and cannot themselves be per-session. Session persistence must stay host-side or the session list fragments. The sandbox, approval, and permission rows are a deliberate boundary: a preset is exactly as privileged as the plugins it names, so letting one relax its own confinement would defeat the confinement.
