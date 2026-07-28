# Agent Note: Web GUI changes close the loop on the existing URL

Status: implemented

English | [中文](2026-07-28-web-gui-feedback-loop.zh.md)

## Problem

The Web agent could identify neither the GUI hosting its session nor the URL the user was viewing. The [runtime-context decision](2026-07-28-web-agent-runtime-context.md) supplies the first fact, but a GUI edit still had no executable acceptance target: source edits, artifact builds, a listening process, and the user's existing page were unrelated observations. Repository affordances made a wrong substitute look valid because `apps/web/package.json` exposed `vite` as its `dev` script and bare Vite returned HTTP 200 even though it could not inject `window.__DSH_BOOT__`.

The incident session recorded three consecutive failures. After changing the theme, turn 2 delegated acceptance to the user with `pnpm run demo:tui` or an unspecified browser application and ran no assembled Web check. Turn 3 read the frontend package script, launched bare Vite on port 5173, treated HTTP 200 as readiness, and reported success; the user instead received the expected missing-`__DSH_BOOT__` white screen. Turn 4 found `dsh web`, rebuilt the shell, started an unmanaged shell-background process on port 3334, and checked only that the new page returned 200 with a boot manifest. It never probed the existing port 3081. In fact, the port-3081 process predated the build, and its static host read the rebuilt dist on the next request, so refreshing the original page already showed the change. Only after the user reported that fact did turn 5 inspect port 3081 and remove the redundant server.

## Decision

`dsh web` publishes one canonical loopback URL as both model-visible orientation and a managed shell fact. The `app:web-surface` prompt section says that unqualified references identify this GUI, names the URL, and defines acceptance as rebuilding the affected Web artifacts and verifying that existing URL after refresh. `DSH_WEB_URL` carries the same value into every foreground or managed background bash call, so the agent can query the target without parsing prose or process listings. The section preserves the no-implicit-DOM, route, or screenshot boundary and does not claim that a LAN alias equals the browser's literal address.

The `apps/web` development script and Vite configuration reject serve mode before opening a port. Their diagnostics identify `apps/web` as a build-only shell, explain that only `dsh web` injects `window.__DSH_BOOT__`, and name the production and HMR entry paths. Vite build mode remains unchanged.

No server restart or replacement is required merely because static artifacts changed. The host reads `index.html` and static assets on each request, while client bundles are also served from their current files with `no-cache`; a refresh of the existing URL is therefore the acceptance path after the relevant shell and plugin bundles are rebuilt. Starting a separate server proves only that a separate server works. If the user explicitly requests another long-running server, the existing managed background-task contract owns its lifecycle and completion notices; shell `&` is not an alternative lifecycle.

## Verification

The keyless fresh-round-trip browser scenario boots the shipped Web composition, drives a real replayed session, snapshots the URL-bearing system-prompt prefix, and invokes the assembled bash tool to prove `$DSH_WEB_URL` equals the scaffold's actual bound URL. A real Vite subprocess test requires serve mode to exit nonzero with the full-host correction. The real-Loader webserver test rewrites a static asset after the process binds and proves the same port returns the new bytes. These assertions inspect prompt state, process exit, shell output, and HTTP bytes rather than an agent's success statement.

## Alternatives considered

**Extend only the system prompt.** Rejected because it would leave the target unavailable to tools, preserve the misleading bare-Vite path, and fail to prove how an existing process observes rebuilt artifacts.

**Remove the `apps/web` development script without guarding Vite.** Rejected because `npx vite`, the exact incident command, bypasses package scripts. Serve mode itself must fail.

**Automatically restart or replace the current Web process after every edit.** Rejected because the static server already reads current artifacts per request, a restart would interrupt the session that requested the edit, and plugin HMR has a separate explicit `dsh web --dev` composition.

**Send DOM, route, or screenshots with each request.** Deferred to a separate logged-input design. Stable URL identity closes this feedback loop without claiming browser state the host does not receive.

## Consequences

Web prompts gain a dynamic URL paragraph, so provider prefix reuse now varies by bound port. Bash processes gain one non-secret managed environment variable. Bare Vite can no longer be used as a shell-only visual sandbox; developers use the full host or build mode instead. In exchange, GUI work has one mechanically observable target, the unsupported startup path fails before a white screen, and a second port can no longer masquerade as proof that the user's current page changed.
