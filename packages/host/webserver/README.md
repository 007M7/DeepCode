# @deepseek-ai/dsh-host-webserver

English | [中文](README.zh.md)

Web HTTP and upgrade-route registration plugin (default-exported `HttpServerService`, config `{host, port, distIndex}`): a `node:http` server that listens on activation and provides `ctx.httpServer`. `register(route)` adds a named `exact`/`prefix` HTTP route; `registerUpgrade(route)` adds an upgrade route for an exact pathname. A duplicate path within either table throws because route patterns are a composition-level contract and a collision is a misconfiguration; both methods return a disposer that removes the registration. `tapIndex(transform)` adds an index.html transform applied in registration order, `port` reads the listening port (the OS-assigned value when `port` is 0), and `host` reads the configured bind host (composition-time facts other plugins adapt to, e.g. the directory-picker chooser). HTTP match order is fixed: exact over the whole table, then longest prefix, then the static dist fallback with the locked semantics: traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Upgrades match exactly and unmatched connections are closed; registration order carries no request-facing semantics.

The package knows no harness concepts: the `/api` HTTP bridge and downlink WebSockets are routes owned by the connection plugin, while plugin bundles and the HMR event stream are routes owned by the modules/hmr plugins. The upgrade handler owns the protocol handshake and connection contents; the webserver only delivers the raw socket and request. `host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure); `distIndex` is an assembly fact the composing app resolves and injects, never self-resolved (dist location is workspace knowledge of the app). Web (browser) shape only — Electron loads dist over `file://` and carries fetch over an IPC bridge, not this server. This package never prints; the URL line belongs to the shell.

A listen failure (EADDRINUSE…) throws out of activation and rejects Loader composition with the bind diagnostic; the failed candidate fiber is disposed. An HTTP request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process. An upgrade-handler exception or upgraded-socket transport error is logged as a warning and destroys its socket. Disposal starts `close()` and `closeAllConnections()`, destroys every tracked upgraded socket, and returns only after the HTTP server and those sockets have closed.

In development, the client-plugin registry synchronously captures each built bundle's stat baseline before it returns, then polls those baselines and re-hashes changed content. Each rescan stages its candidate table, graph, and watch map before publishing them, so a baseline failure preserves the prior graph. An immediate rebuild therefore cannot disappear into an asynchronously established watch baseline; a rename window marks the path dirty, retains the last successful baseline, and forces a re-hash when the bundle reappears even with identical metadata.

## Model Experience

None, as the package is a Web carrier between the browser and the HTTP/upgrade routes other plugins register; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No TLS, auth, or origin policy** — binding a non-loopback address exposes the server to that network; deployment hardening (or fronting it with a real reverse proxy) is deliberately out of scope for the dev-facing v1.
- **The starter MIME table is minimal** — extensions beyond the vite-emitted set fall back to `application/octet-stream`; extend the table when an asset class actually ships.
- **Socket options are fixed** — config selects the bind host and port, while backlog and other socket settings remain internal until a deployment needs them.
