# `@deepseek-ai/dsh`

The `dsh` command-line entry follows the `apps/` assembly tier: `apps/*` are product assemblies over `packages/*` libraries. Plain `dsh [config.yml]` boots the interactive TUI coding agent, `dsh -p "task"` runs one headless turn, and `dsh web` serves the browser UI.

The TUI surface:

- boots the shipped default config (`examples/tui-agent/cordis.yml`) or an explicit config argument, through [`dsh-app-boot`](../../packages/ui/app-boot/README.md);
- resumes a persisted session with `dsh --resume <session-id>` — the form the TUI prints on exit and lists under `/resume`; the flag sets `RESUME_SESSION_ID` before boot so the shipped config rehydrates that session, and a missing or unreadable id fails loud and exits nonzero;
- treats the **invoking directory** as the workspace — sessions, relative paths, and workspace instructions resolve from the cwd;
- tells the agent where its own source lives: after boot it adds a prompt section naming this harness checkout, resolved from the launcher's real path so it holds under a PATH symlink and an arbitrary cwd, so the self-referential `cordis` toolset can read and modify it;
- applies the personal overlay from `~/.dsh` (see [app-boot's Personal config](../../packages/ui/app-boot/README.md#personal-config)): `.env` fills environment gaps (ambient > project `.env` > personal `.env`), `config.yaml` patches the booted tree.

The Web surface treats its invoking directory as the default project, loads applicable `AGENTS.md`/`CLAUDE.md` instructions into each agent-loop request prefix with a 65,536-byte render budget, and opts into first-message model titles. The headless surface retains deterministic fallback titles without making the auxiliary title-model request.

## Install (developer machine)

Symlink the source-running launcher onto your PATH; it resolves the checkout through its own real path, so code changes apply on the next launch with no build step:

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

`pnpm run demo:tui` runs the same entry from the repo root. The built form (`lib/bin.js`, via `pnpm run build`) boots the same config under plain Node.
