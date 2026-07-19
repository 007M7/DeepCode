# @deepseek-ai/dsh-client-ui-slots

Slot registry pure core: SlotMap declaration merging, SlotCore (single/list/keyed), ScopedSlots types. Contract: api-contracts v3 §1 + the slot type-chain design (composed-props registration).

A SlotMap entry declares `{ kind; scope; owner; children? }`. `owner` is the render-side props share the slot-owning package declares; registrants reference it through `OwnerOf<K>` and never re-state it. The registrant's injected share `I` stays a local type at the registration site, inferred from the inject factory (`InjectFactory<E, I, Ctx>`; context-narrowing wrappers pin `Ctx`). `SlotCore.register` constrains the component against `ComposedProps<K, I>` — owner share & bottom-typed standard share (`StandardOf`) & `children`-gated slots face (`SlotsFaceOf`) & `I` — through the bare-call-signature `SlotComponent` position. `children` optionally whitelists delegable sub-slot keys (`ChildrenOf`; constraint-side validation only — delivery stays with the renderer); `narrowSlots` narrows a `ScopedSlots` surface to a subset whitelist.

## Model Experience

None, as the slot registry is browser-side UI plumbing; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`StandardOf` is a constraint-position bottom type (`useSession: never`), not the arriving hook type** — this zero-dependency layer cannot see the conversation snapshot; components declare the narrowed hook they consume, and what actually arrives is web-react's renderer responsibility.
- **The legacy `props` entry member (with `OwnerProps`'s Partial owner share) remains for migration** — entries not yet declaring `owner` keep the P-I full-props constraint; both forms disappear with the last legacy declaration.
