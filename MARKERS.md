# Marker Classification Report

**Generated from:** `feat/acp-4-session-cwd`  
**Worktree branch:** `chore/classify-markers`  
**Classification standard:** `docs/development.md`

| Tag | Urgency | Meaning |
|-----|---------|---------|
| `FIXME` | 🔴 **Highest** | Blocks a release — must be resolved or explicitly waived by reviewers |
| `TODO` | 🟡 **Medium** | Should be fixed soon, once resources permit |
| `XXX` | ⚪ **Lowest** | Someday-maybe; no commitment |

---

## 🔴 FIXME (2 occurrences — release-blocking)

### `vendor/loader/src/index.ts:108`
```
// FIXME merge config
```
Comment in vendored cordis loader — config merging is incomplete.

### `vendor/cordis/src/fiber.ts:376`
```
// FIXME internal/fiber-info
```
Internal fiber-info access in vendored cordis fiber.

---

## 🟡 TODO (30+ occurrences — should be fixed soon)

### Sub-agents / spawn-fork
| File | Marker |
|------|--------|
| `packages/agent-loop/src/index.ts:117` | `TODO(sub-agents): spawn/fork land here` |
| `packages/agent-loop/README.md:75` | `Sub-agents: TODO seam on AgentLoop.create()` |
| `packages/agent/src/types.ts:104` | `TODO(sub-agents): spawn/fork seams` |

### Permission / sandbox gates
| File | Marker |
|------|--------|
| `packages/acp/README.md:53` | `TODO(rfc010-permission-gate)` — permission gate not implemented |
| `packages/acp/src/index.ts:24` | references `TODO(rfc010-permission-gate)` |
| `packages/acp/src/index.ts:506` | `TODO(rfc010-cancel-prestep)` — queued turn may survive cancel |
| `packages/acp/src/index.ts:545` | same window as `TODO(rfc010-cancel-prestep)` |
| `packages/acp/tests/turns.spec.ts:202` | references `TODO(rfc010-cancel-prestep)` |
| `examples/acp-agent/tests/acp.e2e.ts:76` | `// Permission gate is deferred (TODO(rfc010-permission-gate))` |
| `packages/acp/README.md:54` | `TODO(rfc010-cancel-prestep)` |
| `packages/acp/README.md:55` | `TODO(rfc010-agent-disposal)` — no per-agent disposer |
| `packages/acp/src/index.ts:442` | `TODO(rfc010-agent-disposal)` |
| `packages/acp/src/index.ts:566` | `TODO(rfc010-agent-disposal)` |
| `packages/tool-bash/README.md:41` | `TODO(permissions)` — commands run with full authority |
| `packages/tool-bash/src/index.ts:31` | `TODO(permissions)` |
| `packages/bash-local/README.md:29` | `TODO(permissions/sandbox)` |
| `packages/bash-local/src/index.ts:7` | `TODO(permissions/sandbox)` |

### Envelope / review markers
| File | Marker |
|------|--------|
| `packages/session/src/index.ts:45` | `TODO(review): revisit the envelope once a real adapter exists` |
| `packages/agent/src/types.ts:75` | `TODO(review): exact envelope/rendering rules` |
| `packages/tools/src/index.ts:48` | `TODO(review): revisit these shapes when the first real tools` |
| `docs/architecture.md:84` | `TODO(review)` — envelope review against live models |
| `docs/architecture.md:102` | `TODO` — tool shapes revisit |
| `docs/rfc/implemented/2026-06-11-content-block-vocabulary.md:15` | `TODO(review)` — revisit once V4 adapter exists |
| `docs/rfc/implemented/2026-06-11-content-block-vocabulary.md:20` | `TODO(review)` — streaming protocol |
| `docs/rfc/implemented/2026-06-11-event-sourced-sessions.md:23` | `TODO(review)` — event vocabulary |

### Tool execution / parallelism
| File | Marker |
|------|--------|
| `packages/agent-loop/src/loop.ts:511` | `// parallel execution is a TODO` |
| `packages/tools/README.md:70` | `What is NOT here (TODO)` |

### Bash / shell state
| File | Marker |
|------|--------|
| `packages/bash-local/src/run.ts:248` | `TODO(stateful-shell)` — stateful designs tracked |
| `packages/bash-local/README.md:21` | `TODO(stateful-shell)` |

### Tool-bash ownership on HMR
| File | Marker |
|------|--------|
| `packages/tool-bash/src/index.ts:23` | `TODO(tool-bash-owner-hmr)` |
| `packages/tool-bash/src/index.ts:165` | `TODO(tool-bash-owner-hmr)` |
| `packages/tool-bash/tests/tools.spec.ts:413` | `TODO(tool-bash-owner-hmr)` |
| `packages/tool-bash/README.md:33` | `TODO(tool-bash-owner-hmr)` |

### Other TODOs
| File | Marker |
|------|--------|
| `packages/agent-loop/src/index.ts:111` | `TODO(demo): each run starting a brand-new session` |
| `packages/agent-loop/README.md:11` | `// a real resume-or-create policy is a TODO` |
| `packages/session/src/index.ts:33` | `TODO, future phase` — persistence plugins |
| `packages/llm-deepseek/src/adapter.ts:56` | `TODO(http): deliberately raw fetch` |
| `packages/session-persistence-sqlite/README.md:5` | `TODO:` — route through cordis DB service |
| `vendor/cordis/src/fiber.ts:38` | `TODO: async validation` |
| `vendor/cordis/src/reflect.ts:250` | `TODO enhance error message` |
| `examples/acp-agent/README.md:35` | `TODO(rfc010-permission-gate)` |
| `docs/rfc/proposed/2026-06-14-acp-multi-session.md:6` | `TODO(rfc010-permission-gate)` / `TODO(rfc010-agent-disposal)` |
| `docs/rfc/proposed/2026-06-14-acp-agent-client-protocol.md:6` | `TODO(rfc010-permission-gate)` / `TODO(rfc010-cancel-prestep)` |
| `docs/rfc/proposed/2026-06-15-optional-code-mode.md:82` | references parallel-execution TODO |

---

## ⚪ XXX (24 occurrences — lowest priority)

Every implemented and proposed RFC in `docs/rfc/` carries this identical marker in its HTML frontmatter:

```
<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->
```

**Affected files (all `docs/rfc/`):**

### Implemented RFCs
1. `docs/rfc/implemented/2026-06-11-tool-schemas-in-prompt-assembly.md`
2. `docs/rfc/implemented/2026-06-11-vendor-cordis-as-source.md`
3. `docs/rfc/implemented/2026-06-11-dev-invariants-over-deep-readonly.md`
4. `docs/rfc/implemented/2026-06-11-tsdown-over-dumble.md`
5. `docs/rfc/implemented/2026-06-11-structured-error-taxonomy.md`
6. `docs/rfc/implemented/2026-06-14-session-persistence.md`
7. `docs/rfc/implemented/2026-06-11-custom-schema-dsl.md`
8. `docs/rfc/implemented/2026-06-15-turn-enclosure-invariant.md`
9. `docs/rfc/implemented/2026-06-13-capability-seams.md`
10. `docs/rfc/implemented/2026-06-11-runtime-arg-validation.md`
11. `docs/rfc/implemented/2026-06-11-event-sourced-sessions.md`
12. `docs/rfc/implemented/2026-06-11-content-block-vocabulary.md`
13. `docs/rfc/implemented/2026-06-11-quality-gates.md`
14. `docs/rfc/implemented/2026-06-13-twin-llm-adapters.md`
15. `docs/rfc/implemented/2026-06-11-property-based-testing.md`
16. `docs/rfc/implemented/2026-06-11-doc-sync-enforcement.md`
17. `docs/rfc/implemented/2026-06-11-microkernel-event-taxonomy.md`
18. `docs/rfc/implemented/2026-06-16-pnpm-over-yarn.md`

### Proposed RFCs
19. `docs/rfc/proposed/2026-06-11-api-extractor-reports.md`
20. `docs/rfc/proposed/2026-06-16-typed-event-schemas.md`
21. `docs/rfc/proposed/2026-06-11-architectural-conformance.md`
22. `docs/rfc/proposed/2026-06-11-deterministic-and-stress-testing.md`
23. `docs/rfc/proposed/2026-06-14-acp-agent-client-protocol.md`
24. `docs/rfc/proposed/2026-06-14-acp-multi-session.md`
25. `docs/rfc/proposed/2026-06-15-optional-code-mode.md`
26. `docs/rfc/proposed/2026-06-11-supply-chain-and-vendor-drift.md`
27. `docs/rfc/proposed/2026-06-11-mutation-testing.md`

### Rejected RFC
28. `docs/rfc/rejected/2026-06-11-immutable-public-surfaces.md`

---

## Summary

| Priority | Count | Main themes |
|----------|-------|-------------|
| 🔴 **FIXME** | 2 | Config merging & fiber-info in vendored cordis |
| 🟡 **TODO** | 30+ | Permission gate (8), sub-agents (3), envelope review (6), HMR ownership (4), tool parallelism (2), stateful shell (2), misc (5+) |
| ⚪ **XXX** | 28 | All RFCs: legacy HTML frontmatter — non-normalized template |
| **Total** | **60+** | |

