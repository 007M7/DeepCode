# AGENTS.md — Examples

Runnable harness compositions. **Examples are not workspaces:** their private package stubs are not built; `tsx` and the Cordis Loader resolve package names through the root `tsconfig.json` paths.

Keep only wiring, demo-only fixtures, and e2e/snapshot scenarios here. Move reusable logic into `packages/`, where coverage and README requirements apply. App-package bins own bootstrapping; examples have no `start.ts`.

## Every example ships e2e smokes (keyless + with-key)

Each example has both smoke tiers:

- **Keyless:** boot the real `cordis.yml` through the Loader, drive it, and assert output plus clean exit. This catches Loader/export-shape failures that hand-mounted tests miss ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **With-key:** send a live-model prompt and verify external state, not the model's claim. Self-skip without `DEEPSEEK_API_KEY`; see [testing.md](../docs/testing.md).

Mock-only examples need only the keyless tier; state the exception in the test.

A keyless smoke launched from a temporary cwd sets `TSX_TSCONFIG_PATH` to the root tsconfig and passes `--expose-internals` when loading HMR.

Do not maintain a prose inventory of example tests here; the `tests/` trees and root scripts are authoritative.

See [the root AGENTS.md](../AGENTS.md) for repo-wide conventions and [docs/architecture.md](../docs/architecture.md) for the design.
