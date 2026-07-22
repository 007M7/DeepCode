# @deepseek-ai/dsh-client-web-react

ctx↔React glue: createSnapshotStore (zustand vanilla + immer + subscribeWithSelector + rafFlush + opt-in persist), bindSnapshotSelector, SessionProvider (dependency-inverted), scopedSlots outlet, RootBindingProvider, useInvoke. Contract: api-contracts v3 §2.

## Model Experience

None, as the ctx↔React glue runs entirely in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The persist middleware corrupts primitive-state stores** — it object-spreads state on save, so a `SnapshotStore<string>` round-trips as a character map; consumers with primitive state hand-roll persistence instead (ui-conversation drafts is the precedent).
- **`UseSession` is deliberately wide (`object` snapshot)** — the dependency direction (runtime → web-react, never the reverse) keeps the real `ConversationSnapshot` type out of reach; session-slot consumers narrow once at their boundary.
- **renderSlot is the single P-I form** — no Suspense, no per-entry lazy loading; the progressive-rendering surface returns with its own project.
