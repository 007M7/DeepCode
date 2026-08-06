# `@deepseek-ai/dsh-cmdline`

English | [中文](README.zh.md)

The command line a dsh launcher hands to the app it boots. The launcher parses only its own flags (`--profile`, `--patch`, the config dumps) and hands **everything after them** to the tree verbatim, so an app owns its flag family, its `--help` text, and its parse errors instead of the launcher knowing them.

## The three launcher values

A launcher calls `provideCmdline(ctx, host)` before any tree entry mounts, which provides:

- `ctx.cmdlineArgs` — the invocation's inner arguments. `get()` is the whole interface, and it returns a snapshot: `dsh --profile tui --resume abc` yields `['--resume', 'abc']`.
- `ctx.appExit` — a bounded process-exit request, wired to the launcher's shutdown controller.
- `ctx.appPatches` — where a startup row records its decisions, for a launcher that recomposes its tree. Omitted by a host that never does.

An embedding host with no command line provides an empty list; that is the honest answer, not a missing value.

## Startup rows and the services their rows wait for

An app reads those arguments from a **startup row** — a plugin that injects `cmdlineArgs` and calls `runStartup(ctx, service, program, plan)`:

```ts ignore
export const name = 'web-startup'
export const inject = ['cmdlineArgs']

export function apply(ctx: Context): Promise<void> {
  return runStartup(ctx, 'webStartup', webCommand(), planWebStartup)
}
```

Every row the app configures from flags injects that startup service in the bundle patch:

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: 127.0.0.1
    port: 3080
```

`runStartup` parses the arguments, asks `plan` what each waiting row's values should be, applies them, and provides the startup service, which is what lets those rows start. On `--help`, `--version`, a parse error, or a `program.error(...)` from the plan, it writes commander's text, disables the waiting rows, and requests exit — the app never starts, and the settlement audit sees a tree that was asked not to start it.

`plan` receives every waiting row's **composed** options, so a decision reads what the bundle patches and the user's own layers agreed on before overriding it; `overrideConfig(row, { port })` replaces exactly the named keys. A row absent from the plan starts on its composed values, and planning a change for a row also enables it.

A row whose required config the startup **supplies** rather than overrides must ship `disabled: true`, because a waiting row's config is validated when its fiber is created — before the startup service arrives — and a missing required key fails the boot there. The one-shot runner's `task` is the shipped example. A row shipped disabled for another reason is turned on the same way: `dsh web --dev` plans `{ disabled: false }` for the HMR receiver.

The decisions also reach the launcher through `ctx.appPatches`, which is what keeps them alive across a recomposition: without it, a user editing a live patch file would rebuild every row from its composed options and silently move a server started on `--port 8080` back to the composed port.

### Why a changed row is recycled

A waiting row's config is resolved when the Loader creates its fiber, which happens while the row is still waiting. Writing a new config onto that fiber never reaches the plugin, so each changed row is disabled and re-enabled, which drops the stale fiber and resolves the config again. A row whose own mount is still in flight is allowed to settle first, so the disable has a fiber to dispose instead of racing one into existence.

Recycling deliberately leaves `inject` alone. Updating a row's `inject` restarts it from its unwrapped callback, which loses the plugin's own static injections — a row that declares `inject = ['httpServer', 'apiProxy']` would come back unable to read either.

### One command line, one owner

A composition has exactly one command-line owner. An app that layers over another one disables the underlying startup row and names both startup services, so the rows it absorbed start on their composed values — [`dsh-headless`](../../bundle/headless/README.md) does this over [`dsh-web-app`](../../bundle/web-app/README.md).

An out-of-tree plugin brings its own commander copy, so commander's control-flow errors are detected structurally rather than by class identity; an identity check would rethrow a printed help as a fatal load failure.

## Model Experience

None, as this package resolves the process's own command line before any session exists.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Launcher flags must precede app arguments.** The split is positional: the first token the launcher does not recognize starts the inner arguments, so `--patch` placed after an app flag belongs to the app. The launcher's parser consumes one `--`, so an app argument that must survive as a literal `--` needs `-- --`.
- **A startup service has no declared owner.** The rows name it and a startup row provides it; nothing links the two statically, so a bundle that ships waiting rows without its startup row fails at settlement (pending entries naming the service) rather than at load.
