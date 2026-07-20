# packages/client/AGENTS.md 供稿（P0-3 ②③）

> 交 i18n-design 落文档；两节英文成稿，措辞可融他的行文，事实面以此为准。

## Section A: Testing and coverage policy (供稿第一段)

```markdown
## Testing and coverage

- **web-runtime is inside the per-file 100% coverage gate** (`pnpm run test:coverage`). New src in `packages/client/web-runtime` needs its branches covered; genuinely unreachable defensive arms take a `/* v8 ignore -- <reason> */` comment with a real reason, never a bare ignore.
- **web-ui is excluded from the coverage gate long-term** (`vitest.config.ts` coverage.exclude), and that is a ruling, not a gap: components are consumables expected to be rewritten, so exhaustive component coverage is negative-value work. Do not add web-ui to the gate, and do not treat its 0% as a debt to pay down file by file.
- **web-ui specs are end-to-end behavior checks, not unit tests.** A jsdom spec renders the component with realistic props (or a driven store/fake client) and asserts what the user would see — nothing about class names, hook internals, or render counts beyond the documented memo contracts. One happy path plus one edge state is a complete spec for a new component.
- The jsdom environment comes from a per-file `// @vitest-environment jsdom` pragma on the first line of the spec — the shared config stays node-env and needs no edits. Spec templates (component and pure-data) live beside the example slots.
- Data-layer semantics (Session/Manager/Connection state machines, wire shapes, reference stability) belong to the web-runtime suites and the apiproxy protocol suite — do not re-assert them from component specs. Browser black-box regression walks belong to `scripts/verify-*.mjs`, not vitest.
```

## Section B: Local gate self-check (供稿第二段)

```markdown
## Before you push: the local check ladder

Run the narrowest rung that covers what you touched; escalate only when the change surface demands it.

1. **Every GUI code change** — `pnpm run test:gui` (seconds, no browser, no server): the web-runtime object/protocol suites plus web-ui jsdom specs. This is the inner loop; run it as freely as a typecheck.
2. **Changes to the build surface, boot wiring, or static serving** (`apps/web`, `apps/cli` web command, vite config, `dsh-host-webserver`) — additionally `pnpm run test:web`: rebuilds the frontend dist, then runs the browser smoke pair (fixture-mode round trip; the real-host case self-skips without `DEEPSEEK_API_KEY`).
3. **Before a PR** — `pnpm run check:pre-push` (the repo-wide gate ladder, including `test:coverage`). During feature development between PR windows this rung is NOT expected on every commit — a red left by someone else's in-flight work gets ledgered, not chased.

If `test:gui` is red on code you did not touch, do not silently fix or silently ignore it: note it in your handoff/mission log so it lands in the next PR window's sweep.
```

## 落点与归属

- 归属：文档正文归 i18n-design（他持 packages/client/AGENTS.md 的笔）；本供稿事实错误找 web-test。
- 模板文件（同目录 component.spec.tsx.template / pure-data.spec.ts.template）：等 arch-session 的 app-shell 坑位目录建出后落进示例坑位（谁的刀先到谁带上，已知会他）；届时 Section A 第 4 条的「live beside the example slots」自动成真，先落文档不阻塞。
