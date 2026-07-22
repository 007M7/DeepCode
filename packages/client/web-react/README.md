# @deepseek-ai/dsh-client-web-react

ctx↔React machinery for the slot terminal design: createSlotRenderer (the SlotRenderer implementation the shell installs into the runtime SlotsService), SessionProvider (framework-wired render prop over the host's current-session source), defineStore (the declarative store shell over the internal zustand engine), bindSnapshotSelector, useInvoke. The snapshot-store engine (createSnapshotStore) is framework-internal via the `./store` subpath; business plugins declare stores through defineStore only.

## Model Experience

None, as the ctx↔React machinery runs entirely in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The persist middleware corrupts primitive-state stores** — it object-spreads state on save, so a `SnapshotStore<string>` round-trips as a character map; the engine hand-rolls persistence instead (see `attachPersistence`).
- **`UseSession` is deliberately wide (`object` snapshot)** — the dependency direction (runtime → web-react, never the reverse) keeps the real `ConversationSnapshot` type out of reach; session-slot consumers narrow once at their boundary.
- **renderSlot is the single P-I form** — no Suspense, no per-entry lazy loading; the progressive-rendering surface returns with its own project.
