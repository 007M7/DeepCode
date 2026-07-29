---
name: dsh-migrate
description: Migrate a user's setup from another coding agent (opencode, pi, Claude Code, Codex) to DSH — porting instruction files, custom commands and skills, hooks, MCP servers, and API/env configuration into their DSH equivalents. Use when the user asks to migrate, switch, or move from another coding agent to DSH.
---

# DSH Migrate

Move a user's existing coding-agent setup onto DSH: instruction files, custom commands, skills, hooks, MCP servers, and API/environment configuration. Port only what has a real DSH equivalent; tell the user plainly when something has none.

## First: identify the source

Ask which agent the user is migrating from if they have not said: **opencode**, **pi**, **Claude Code**, or **Codex**. The mapping differs per source. Then locate that agent's config (ask the user, or inspect the obvious locations: `~/.claude/` and `.claude/` for Claude Code, `~/.codex/` and `.codex/` for Codex, the opencode/pi config dir the user names). Read what exists before proposing changes; never invent files the user does not have.

## DSH targets

Every migration lands in one of these DSH surfaces. Verify the exact path against the running install rather than assuming.

- **Workspace instructions**: DSH reads `AGENTS.md` and `CLAUDE.md` (and `AGENTS.local.md` / `CLAUDE.local.md`) from the project, walking up to the project root, plus a user-global `~/.dsh/AGENTS.md`. `CLAUDE.md` is read as-is, so a Claude Code project needs no rename.
- **Personal overlay** (user-global, applies to every DSH session): the Harness home `~/.dsh/` holds `config.yaml` (a top-level YAML array of Loader patch entries that patch the booted plugin tree), `.env` (fills environment gaps only — ambient env and the invoking directory's `.env` win), `AGENTS.md`, and `skills/`.
- **Skills**: directory-bundle or flat-Markdown skills load from `.dsh/skills/` and `.agents/skills/` in the project, and `~/.dsh/skills/` and `~/.agents/skills/` for the user. Personal skills go in `~/.dsh/skills/<name>/SKILL.md`. Use the `skill-creator` skill to author them.
- **Hooks**: DSH runs a mapped subset of an existing Claude Code or Codex hook config through compatibility bridges — no rewrite needed for the supported subset. See the per-source sections.
- **MCP servers**: DSH has no native MCP client. Reach MCP servers through the `mcporter` skill / CLI, which can call servers already configured for other tools.
- **API / model config**: DSH uses `DEEPSEEK_API_KEY` (and optional `DEEPSEEK_BASE_URL`) from `.env` (root, invoking directory, or `~/.dsh/.env`). Model and provider are chosen in the booted `cordis.yml` / personal overlay, not per-provider config files.

## Per-source mapping

### Claude Code

- `CLAUDE.md` → read as-is by DSH workspace instructions; keep it, or consolidate into `AGENTS.md`. User-global rules → `~/.dsh/AGENTS.md`.
- `.claude/hooks.json` (or a settings file's `hooks` key) → the `@deepseek-ai/dsh-hooks-claude` bridge runs the mapped command-hook subset on DSH's interception seams, with `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution. Add it to the booted `cordis.yml` (or personal overlay) pointing `configPath` at the existing file. Anything outside the mapped subset should become a native DSH plugin, not a shimmed hook.
- Slash commands → DSH commands are plugin-provided; there is no drop-in import. Reimplement genuinely needed ones as skills (`~/.dsh/skills/`) or plugins.
- MCP servers in Claude config → use `mcporter` to reach them; DSH has no native MCP.
- `ANTHROPIC_API_KEY` etc. do not transfer; DSH is DeepSeek-backed via `DEEPSEEK_API_KEY`.

### Codex

- Codex `AGENTS.md` → DSH already reads `AGENTS.md`; keep it. User-global → `~/.dsh/AGENTS.md`.
- Codex hook config → the `@deepseek-ai/dsh-hooks-codex` bridge runs a deliberate subset (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`; regex-only matchers; no plugin env injection; no pre-tool approval/rewrite). Add the bridge to the booted config with `configPath` at the existing Codex hooks file. State the unsupported points to the user rather than implying full parity.
- MCP servers → `mcporter`.
- API/env → `DEEPSEEK_API_KEY` in `.env`.

### opencode / pi

- These have no compatibility bridge. Port by concept, not by file:
  - Agent/system instructions → `AGENTS.md` (project) and `~/.dsh/AGENTS.md` (user-global).
  - Provider/model and any plugin-style tuning → the booted `cordis.yml` or `~/.dsh/config.yaml` overlay patches; API keys → `.env`.
  - Reusable prompts/commands → skills under `~/.dsh/skills/`.
  - MCP servers → `mcporter`.
- pi has no native MCP by design; the `mcporter` route is the same as for DSH.

## Do the migration

1. Confirm the source agent and read its actual config.
2. For each capability (instructions, hooks, commands/skills, MCP, API/env), map it to the DSH target above, or tell the user it has no equivalent.
3. Write the ported files (`AGENTS.md`, `~/.dsh/AGENTS.md`, `~/.dsh/config.yaml`, `~/.dsh/.env`, skills). For hook bridges, add the plugin entry to the booted config.
4. Verify: hooks need the bridge plugin present in the running tree; MCP needs `mcporter` reachable; API needs `DEEPSEEK_API_KEY` set. Test in a real DSH session, not just on paper.
5. Summarize what was ported, what was reimplemented, and what has no DSH equivalent.
