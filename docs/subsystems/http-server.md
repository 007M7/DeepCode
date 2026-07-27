# HTTP Server

English | [中文](http-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) is the web-shape HTTP carrier for the GUI host: a single `node:http` plugin providing `ctx.httpServer`, a named-route registry plus index.html transform taps over a static dist fallback. It is not part of the agent-loop spine and not a capability seam — it knows no harness concepts, and every feature surface (the `/api` bridge, plugin bundles, the HMR event stream) is a route some other plugin registers ([layering note](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)). Web (browser) shape only: Electron loads dist over `file://` and carries fetch over an IPC bridge, not this server.

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

Match order is fixed: exact table first, then longest matching prefix, then the static dist fallback. Registration order carries no request-facing semantics — named routes are composed to be disjoint, and the fallback answers anything not yet claimed during the boot window. The fallback keeps locked semantics: non-GET/HEAD is 405, traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), and unknown extensions ship as octet-stream ([`static.ts`](../../packages/host/webserver/src/static.ts)).

## Config

```ts type-equiv
/** Gateway config: listen address plus the static dist anchor (injected by the composing app, never self-resolved). */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Absolute path of index.html inside the static root (dist location is workspace knowledge of the app). */
  distIndex: string
}
```

`host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure); there is no TLS, auth, or origin policy, so a non-loopback bind exposes the server to that network. `distIndex` is an assembly fact the composing app resolves and injects.

## The service

`HttpServerService` (`ctx.httpServer`) listens immediately on activation; a listen failure (EADDRINUSE…) throws out of init — a FAILED fiber the boot's fail-loud sweep reports. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws, because route patterns are a composition-level contract and a collision is a misconfiguration. `tapIndex(transform)` adds a pure html-to-html transform applied to every index response — `/` and each SPA fallback — in registration order; [dsh-client-modules](../../packages/client/modules) uses it to inject the boot manifest. `port` reads the listening port, the OS-assigned value when `config.port` is 0.

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. The package never prints: the URL line belongs to the shell. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).
