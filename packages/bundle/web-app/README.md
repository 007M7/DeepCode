# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it sets the coding persona, inserts the Web host rows (webserver, API gateway, workspace, projection cache, storage) and the browser plugin roster, and mounts this package's `web-runtime` glue plugin (config `{mode, printUrl, surfaceContext, lanAddresses}`). That plugin resolves the built frontend dist through `@deepseek-ai/dsh-frontend`'s exports, enables the optional HMR row before client-module discovery so the first development graph contains its reload receiver, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, registers the harness-source and web-surface prompt sections plus the bash-visible `DSH_WEB_URL`/`DSH_WEB_MODE` runtime variables when `surfaceContext` is true, and prints the `dsh web:` URL line when `printUrl` is true, after its Loader tree settles so a sibling failure cannot announce a dead app. This bundle also owns the app command line: the `web-startup` row ([`src/startup.ts`](src/startup.ts)) parses `--host`, `--port`, `--dev`, and repeatable `--trusted-host` from `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)) and prints the app's `--help`. Every row it configures injects `webStartup`, so nothing binds a port before argument resolution and `dsh --profile web --help` starts no server. `mode` and `lanAddresses` resolve on every boot because they describe the invocation. [`dsh-headless`](../headless/README.md) is a sibling surface over the same base and does not mount this bundle.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the HMR/rebuild update contract for the active mode, and the instruction not to start replacement servers. `DSH_WEB_URL` and `DSH_WEB_MODE` additionally appear in the managed bash environment with their descriptions, resolved per invocation from the live server. When it is false, neither section nor the variables are registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (port and mode are boot facts), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
