# @deepseek-ai/dsh-host-webserver

Plain HTTP route-registration plugin (default-exported `WebServerService`, config `{host, port, distIndex}`): a `node:http` server that listens on activation and provides `ctx.webServer` — `register(route)` adds a named `exact`/`prefix` route (duplicate `(kind, path)` throws: route patterns are a composition-level contract, so a collision is a misconfiguration; the returned disposer removes the route), `tapIndex(transform)` adds an index.html transform applied in registration order, and `port` reads the listening port (the OS-assigned value when `port` is 0). The match order is fixed — exact over the whole table, then longest prefix, then the static dist fallback with the locked semantics: traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), unknown extensions ship as octet-stream, non-GET/HEAD is 405. Registration order carries no request-facing semantics.

The package knows no harness concepts: the `/api` bridge is the connection plugin's route, plugin bundles and the HMR event stream are the modules/hmr plugins' routes. `host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure); `distIndex` is an assembly fact the composing app resolves and injects, never self-resolved (dist location is workspace knowledge of the app). Web (browser) shape only — Electron loads dist over `file://` and carries fetch over an IPC bridge, not this server. This package never prints; the URL line belongs to the shell.

A listen failure (EADDRINUSE…) throws out of activation — a FAILED fiber the boot's fail-loud sweep reports. A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process. Disposal pairs `close()` with `closeAllConnections()` because held-open responses (SSE) never end on their own.

In development, the client-plugin registry synchronously captures each built bundle's stat baseline before it returns, then polls those baselines and re-hashes changed content. Each rescan stages its candidate table, graph, and watch map before publishing them, so a baseline failure preserves the prior graph. An immediate rebuild therefore cannot disappear into an asynchronously established watch baseline; a rename window marks the path dirty, retains the last successful baseline, and forces a re-hash when the bundle reappears even with identical metadata.

## Model Experience

None, as the package is a pure HTTP carrier between the browser and the routes other plugins register; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No TLS, auth, or origin policy** — binding a non-loopback address exposes the server to that network; deployment hardening (or fronting it with a real reverse proxy) is deliberately out of scope for the dev-facing v1.
- **The starter MIME table is minimal** — extensions beyond the vite-emitted set fall back to `application/octet-stream`; extend the table when an asset class actually ships.
- **Socket options are fixed** — config selects the bind host and port, while backlog and other socket settings remain internal until a deployment needs them.
