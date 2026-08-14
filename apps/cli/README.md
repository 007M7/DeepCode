# `@deepseek-ai/dsh`

English | [中文](README.zh.md)

This package owns the `DeepCode` terminal entry and the underlying `dsh` profile launcher. Profiles are ordered stacks of plugin-bundle patch layers under the user's own overrides. [`src/args.ts`](src/args.ts) owns the command grammar, and [`src/bin.ts`](src/bin.ts) loads only the selected runner. Invalid commands, options from another mode, configuration errors, and boot failures exit nonzero.

## Entry modes

| Command | Purpose |
|---|---|
| `dsh --profile <name>` | Boot the named profile under `$DSH_HOME/profiles/<name>`. |
| `dsh --profile headless "job"` | Run one fresh persisted session, print the final answer, and exit. |
| `deepseek` | Start the complete local terminal Agent UI directly. |
| `dsh cli` | Equivalent profile-launcher form of `deepseek`. |
| `dsh web` | Alias of `--profile web`. |
| `dsh plugin --profile <name> <pnpm args>` | Manage a profile's plugins by forwarding to pnpm in the profile directory. |

The invoking directory is the default workspace root. The `cli`, `web`, and `headless` profiles auto-initialize on first use from shipped templates; any other profile must be created through `dsh plugin`. The local CLI is an Ink terminal UI titled `DeepCode`, with the reference blue pixel-whale welcome card, streamed responses, tool and approval state, a multiline composer, history, command completion, session resume, provider-discovered model/reasoning selection, model questions, and masked `/login`. It preserves normal terminal scrollback instead of taking the alternate screen. Persistent terminal tools are mounted on non-Windows hosts; Windows keeps the base profile's PowerShell tool without claiming persistent PTY support.

The package manifest exposes both `dsh` and `deepseek` bins. npm-compatible installers generate an extensionless POSIX shim plus `.cmd` and `.ps1` Windows shims, so `deepseek` is the same entry in Command Prompt, PowerShell, and either shell hosted by Windows Terminal. Both `deepseek` and `dsh cli` set the process title to `DeepCode` before booting the shared `cli` profile; no shell-specific CLI implementation exists.

The repository-root `install-deepcode.cmd` is the supported downloaded-source installer on Windows. It restores the locked workspace, builds Host artifacts, writes one direct `deepseek.cmd` launcher into npm's global command directory, and persists that directory on the user's `PATH`. The launcher works in CMD and PowerShell under Restricted script policy without creating an npm package self-link. Re-running it updates the launcher and build in place. The source checkout must remain at its installed path; `uninstall-deepcode.cmd` removes the owned launcher but leaves the shared npm command directory on `PATH` for other global tools.

## App arguments

The launcher parses only its own flags and hands everything after them to the booted profile, where any injected app plugin may parse the shared immutable snapshot ([`dsh-cmdline`](../../packages/boot/cmdline/README.md)). Launcher flags therefore come first, and the first token the launcher does not recognize starts the app's arguments:

```sh
dsh --profile web --port 8080       # --port belongs to the web app
deepseek                            # direct local terminal UI
dsh cli                             # equivalent profile launcher
dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
dsh --profile headless "run the tests"
dsh --profile web --help            # the web app's flags, not the launcher's
dsh --help                          # the launcher's own help
```

## Profiles

A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer).

The tree composes over an empty root:
- each bundle's patch in `dsh.profile.bundles` order
- then the profile's `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`
- then `--patch` overlays

Bundles named in `dsh.profile.bundles` resolve from the dsh installation first (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-cli-app`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`), then from the profile's own `node_modules`, where pnpm installs out-of-tree plugins.

Use `--dump-default-config` and `--dump-config` to inspect the composed tree without booting it.

The [CLI behavior reference](reference/README.md) owns exact layer precedence, flags, shutdown behavior, deployment defaults, and source execution.

## Development

Production runs require built package and frontend artifacts. From the repository root, run `pnpm run build` separately, then use `pnpm dsh <args...>` to run the TypeScript entry and forward every argument; the [source-execution reference](reference/README.md#source-execution) owns the module-resolution contract.
