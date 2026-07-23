# @deepseek-ai/dsh-client-web

Web shell library: `bootWebShell(el, seams?)` mounts the whole client — loader machinery (statically held; a loader cannot load itself), pure-library module-table seeding, AppRoot (boot loading page → settled → full UI in one switch), and the SessionProvider/scopedSlots assembly closure. The vite application entry lives in apps/web and only calls `bootWebShell`. Contract: api-contracts v3 §9.3.

The optional `seams` parameter forwards the client loader's `fetchBundle`/`executeBundle` transport overrides (`BootSeams`); production callers omit it — it exists for test environments where `<script>` execution cannot reach the page context (jsdom).

The shell owns browser-title projection. With a selected session carrying a durable title, it renders `<session title> — <existing HTML title>` and reacts to later title revisions; no selection or a selected untitled session preserves the existing title, and shell unmount restores it. The existing HTML title remains the configurable product suffix.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One-shot rendering by design** — the UI waits for `loader.settled()`; a single plugin failure keeps the loading page with a loud error, no partial availability (progressive rendering returns with its own project).
- **No HMR** — the dev loop is tsdown watch + manual refresh for plugins; vite serves only the shell.
- **Narrow-window acceptance is deferred** — the concession chain is implemented in ui-layout but the shell-level narrow-viewport walkthrough is a P-II acceptance item.
