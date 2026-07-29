# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: three-column AppFrame (drag handles and concession chain) plus the `ctx.layout` panel-geometry service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, and `conversation.empty`. The sidebar is fixed-width (only details shrinks, then auto-closes); a closed sidebar retains a 56px control rail while details closes to zero width. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, plus the theme's alias tokens as inline variables on body).

AppFrame reads the runtime Session projection: `baselinesReady` selects loading, a page-local `SessionListState.intent` selects the empty composer, and a connected Session renders through `SessionProvider`. The first ready active Session may restore an open details width across reload; New Session and every later current-Session change close details before paint, including selection invalidation after deletion. The conversation and empty-state owner shares are empty; each registrant obtains business data from standard hooks and actions from its own inject face. The sidebar owner share contains only `collapsed` and `width`; navigation actions belong to sidebar's own injected service face.

The `/client` export surface is the plugin body (`apply`/`inject`), `LayoutService`, and the four owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal; tests import internals through `/src`.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Details width is global, not retained per Session** — changing or losing its active Session closes the panel and forgets a dragged width; returning to that Session does not reopen it.
- **Concession-chain auto-close derives a zero width without touching the persisted open flag** — the panel restores itself when the window widens; consumers must not read `details.open` as the rendered truth.
- **Scroll anchoring during squeeze reflow is not implemented** — deferred with the virtualized-list project.
