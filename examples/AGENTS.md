# AGENTS.md — Examples

Runnable harness compositions. **Examples are not workspaces:** private package stubs are not built. App bins load each `cordis.yml` through `tsx`; package names resolve through root `tsconfig.json` paths, not `node_modules`.

Keep wiring, demo fixtures, and e2e/snapshot scenarios here. Move reusable logic into `packages/`, with coverage and a README. App bins own bootstrapping; examples have no `start.ts`.

## E2E smokes

Each example has both:

- **Keyless:** boot the real `cordis.yml` through the Loader, drive it, and assert output and clean exit. Catches Loader/export-shape failures hand-mounted tests miss ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **With-key:** send a live-model prompt and verify external state, not the model's claim. Self-skip without `DEEPSEEK_API_KEY`; see [testing.md](../docs/testing.md).

Mock-only examples require only the keyless tier; state that exception in the test.

Keyless stdio smokes use `@deepseek-ai/dsh-loader-smoke` for isolation, root-tsconfig loading, subprocess lifecycle, diagnostics, EOF, and cleanup; tests supply paths, environment, input, and assertions.

Do not inventory example tests here; the `tests/` trees and root scripts are authoritative.

In `cordis.yml`, comment only non-obvious wiring, load-order consequences, replay, security boundaries, and configuration scope. Do not narrate visible entries; use [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for required coverage and editorial judgment.

See [the root AGENTS.md](../AGENTS.md) for repo-wide conventions and [docs/architecture.md](../docs/architecture.md) for the design.
