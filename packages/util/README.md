# util/ — low-level shared utilities

Zero-dependency primitives shared across the other groups. A package lands here when it owns a tiny, foundational type or helper that several capability families need but that belongs to none of them — keeping it out of any one group avoids a capability package depending on an unrelated one just to reach a shared primitive. These are **support** packages: small, stable, and free of harness dependencies.

| Package | Role |
|---|---|
| `brand/` | The type-only `Branded<B>` nominal-typing primitive (no runtime code, no harness deps) |

`dsh-brand` is the canonical case: it owns ONLY the `Branded<B>` helper, so a capability package can brand the ids it owns (`dsh-bash`'s `BashTaskId`/`OwnerToken`, `dsh-session`'s `SessionId`, …) by depending on `dsh-brand` alone, without pulling in an unrelated package just to reach `Branded`.
