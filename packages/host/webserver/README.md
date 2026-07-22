# @deepseek-ai/dsh-host-webserver

Web-shape HTTP carrier: a `node:http` server routing `/api/*` to an injected fetch-shaped handler (node:http ↔ WHATWG bridge with SSE streamed out chunk by chunk) and everything else to static file serving with the step1-locked semantics — traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), unknown extensions ship as octet-stream, non-GET/HEAD is 405.

The package has zero workspace dependencies on purpose: the handler arrives by structural typing (`{ fetch: typeof fetch }`), so `webserver ← runtime` is a runtime injection relationship, never a package dependency. Web (browser) shape only — Electron loads dist over `file://` and carries fetch over an IPC bridge, not this server. This package never prints; the URL line belongs to the shell.

Client-disconnect detection hangs off the **response** `close` event, not the request: since Node 16, `IncomingMessage` `close` fires as soon as the request body is consumed (immediately for a bodyless GET), which would abort every SSE stream right after open. `RunningWebServer.close()` pairs `close()` with `closeAllConnections()` because SSE connections never end on their own.

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is answered 400 — or the socket destroyed when headers are already out — and reported to `onError`; it never becomes a process-killing unhandled rejection.

## Model Experience

None, as the package is a pure HTTP carrier between the browser and the injected API handler; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No TLS, auth, or origin policy** — the server binds `0.0.0.0` and trusts its network; deployment hardening (or fronting it with a real reverse proxy) is deliberately out of scope for the dev-facing v1.
- **The starter MIME table is minimal** — extensions beyond the vite-emitted set fall back to `application/octet-stream`; extend the table when an asset class actually ships.
- **`port` is the only listen knob** — bind address and socket options are fixed until a deployment needs them.
