# `@deepseek-ai/dsh`

English | [中文](README.zh.md)

The `dsh` command-line entry follows the `apps/` assembly tier: `apps/*` are product assemblies over `packages/*` libraries. Plain `dsh` boots the interactive TUI coding agent, `dsh -p "task"` runs one headless turn, and `dsh web` serves the browser UI.

Argv is parsed once through a [Commander](https://github.com/tj/commander.js) adapter ([`src/args.ts`](src/args.ts)): one program whose default (no subcommand) is the TUI/headless surface (`--config`, `-p`/`--prompt`, `--resume`) and whose `web` subcommand is the browser UI. `src/bin.ts` switches on the resolved mode and dynamic-imports only that mode's module. `dsh --help` lists every mode and `dsh web --help` renders the web usage, `dsh --version` prints this app's version, and an unknown option or a mistyped `--resume` fails loud (stderr, exit 1) instead of misrouting. `dsh web`'s `--host`/`--port` are unvalidated pass-through overrides: the `dsh-host-webserver` schema is the single source of both the default (the shipped `cordis.yml` value when a flag is absent) and validity, and rejects a bad value at boot. `--trusted-host` appends named authorities for the /api browser-trust fence; an all-interfaces bind additionally derives the machine's LAN IP literals itself ([`src/app-cli-entry.ts`](src/app-cli-entry.ts)), so the printed LAN URL works without flags.

The TUI surface:

- boots the shipped default config (`examples/tui-agent/cordis.yml`), or the tree named by `--config <path>` (the demo/test escape for booting an alternate example tree), through [`dsh-app-boot`](../../packages/ui/app-boot/README.md);
- resumes a persisted session with `dsh --resume <session-id>` and, when the Node host exposes `process.execve`, supplies the TUI's in-place handoff host: after selector preflight and current-session flush, the host disposes the app and replaces the process with a normalized `dsh --resume <id>`; runtimes without process replacement keep the displayed command fallback. The flag provides the id on the boot context under `RESUME_SESSION_ID_KEY` (no environment variable), which the shipped config reads through `!!js`, and a missing or unreadable id fails loud instead of creating a fresh session;
- treats the **invoking directory** as the workspace — sessions, relative paths, and workspace instructions resolve from the cwd;
- tells the agent where its own source lives: after boot it adds a prompt section naming this harness checkout, resolved from the launcher's real path so it holds under a PATH symlink and an arbitrary cwd, so the self-referential `cordis` toolset can read and modify it;
- applies the personal overlay from `~/.dsh` (see [app-boot's Personal config](../../packages/ui/app-boot/README.md#personal-config)): `.env` fills environment gaps (ambient > project `.env` > personal `.env`), `config.yaml` patches the booted tree.

The Web and headless surfaces boot one shared composition (`cordis.yml`): both treat the invoking directory as the default project and Workspace root, create named Workspaces beneath that root unless `--workspace-root <path>` overrides it, load applicable `AGENTS.md`/`CLAUDE.md` instructions into each agent-loop request prefix with a 65,536-byte render budget, and opt into first-message model titles. Headless differs only in listening on an OS-assigned port (parallel `dsh -p` runs never collide; the stderr-printed URL opens the live session in a browser). Both need the frontend dist and client bundles built (`pnpm run build && pnpm run build:web`).

The shipped TUI and Web compositions register the native DeepSeek adapter plus pi-ai OpenAI and Anthropic profiles. Credentials and endpoint overrides come from the provider-standard `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`, `OPENAI_API_KEY` / `OPENAI_BASE_URL`, and `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` pairs in the boot's layered environment.

`DSH_TOOLS_MODE` selects the tool presentation mode for the whole Web/headless process: `native` (the schema default when unset), `code` (the `run_code`-only Code Mode wire), or `both`; any other value fails loud at boot through the `dsh-tools` config schema. It is a TEMPORARY seam — process-wide because Loader composition is static — and is removed once the web UI owns per-session tool-mode selection; the TUI surface ignores it (its config tree pins its own mode).

## Install (developer machine)

Symlink the source-running launcher onto your PATH; it resolves the checkout through its own real path, so code changes apply on the next launch with no build step:

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

Source launches run `apps/cli/src/bin.ts` through tsx's ESM-only hook (`node --import tsx/esm`), which transforms TypeScript and projects the root tsconfig `paths` map into module resolution. Node's native TypeScript modes are not used: Node 26 removed `--experimental-transform-types`, and strip-only mode rejects syntax the source graph relies on (vendored parameter properties, decorators, runtime enums/namespaces). The CJS hook stays off because the source graph is ESM-only and the CJS resolver adds ~0.4s of startup. `bin/dsh` pins `TSX_TSCONFIG_PATH` to the checkout's root tsconfig so resolution is cwd-independent, and the `dsh-source-launch-smoke` node-compat gate runs this exact launch vector on every supported Node line. tsx applies the `paths` map without checking dependency declarations, so declaration completeness rests on the static gates: the TUI configs resolve bare plugins through `examples/package.json`, the Web/headless `cordis.yml` through this package's `dependencies`, and `verify-cordis-config` requires every configured bare plugin to be declared, while allowing unrelated dependencies.

`pnpm run dsh` runs the same entry from the repo root and forwards arguments directly, for example `pnpm run dsh -p "task"`. The built form (`lib/bin.js`, via `pnpm run build`) boots the same config under plain Node.
