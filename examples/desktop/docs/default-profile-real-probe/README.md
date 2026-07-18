# default-profile-real probe (2026-07-18)

Isolated real-machine verification for `fix/default-profile-real` (default
profile → stdio-deepseek + missing-key guided-switch card).

## Isolation (mandatory)

`--user-data-dir=/tmp/dsh-probe-default-real/user-data` (Electron caches +
Local Storage) AND `DSH_DESKTOP_HOME=/tmp/dsh-probe-default-real/dsh-home`
(shell overlay + config.json + `.onboarded` sentinel). Team-lead flagged
that a prior probe wrote through to the user's real `~/.dsh-desktop/user-
overlay.cordis.yml` because DSH_DESKTOP_HOME wasn't isolated; this probe
respects both.

Driver: `/tmp/dsh-probe-default-real/run.sh {with-key|no-key} [port]`.

## Scenarios

### 01 · no-key boot (`01-no-key-boot.png`)

Boots stdio-deepseek with DEEPSEEK_API_KEY unset. Confirms:
- Bottom-right chip: `stdio-deepseek · deepseek-v4-flash` (NEW DEFAULT
  correctly landed — was `daemon-echo · mock-echo` before this change)
- Composer model chip: `deepseek-v4-flash` (matches profile default)
- Status bar: `crashed` (expected — the deepseek runtime dies during
  plugin load because this dev-clone snapshot has a `workspaceContext`
  schema drift; NOT the api-key error we designed against)
- Banner: **generic "Runtime warning"** — the raw message reaching
  the classifier is `runtime not writable` (from
  `transport.js:53 write() throws when stdin isn't writable`), which
  correctly falls through to the generic bucket. My missing-api-key
  regex would ONLY match if the deepseek plugin actually got to throw
  its api-key error, which requires the config schema to pass first.

### 02 · guided-switch card (synthetic inject, `02-guided-card-injected.png`)

Fires `showRuntimeErrorBanner('llm-deepseek: an API key is required
(Config.apiKey or $DEEPSEEK_API_KEY)')` via the __dshRenderer test seam
so we can see the classifier + banner logic end-to-end without needing
the real llm-deepseek error to surface. Confirms:
- Banner title: **"! DEEPSEEK_API_KEY needed for real-model profile"**
- Hint: full two-option copy (set env in .env/shell, or try keyless demo)
- Switch button: **"Switch to keyless demo (daemon-echo)"** (ghost small,
  under hint, wired to `window.dsh.startRuntime('daemon-echo')`)
- Layout: amber-tinted banner sits above the welcome cards, NO red wall,
  full-width row (respects density spec)

### 03 · with-key boot (`03-with-key-boot.png`)

Boots stdio-deepseek with the dev-clone `.env` key loaded. Same shape as
#01 in this environment because the config schema drift dies before the
key check — the WITH-key scenario would surface `status=ready` +
`no banner` only after the dev clone is bumped past the `workspaceContext`
requirement. Documenting for reproducibility.

## Known limits (dev-clone drift)

`deepseek-harness-dev` currently requires `workspaceContext` in the
agent-spine-demo entry (packages/examples/agent-spine-demo/src/index.ts:94).
The demo repo's `config/deepseek-jsonrpc.yml` predates that requirement, so
the runtime dies at config validation before either the key check or the
actual daemon handshake. This is orthogonal to the default-profile change
and does NOT block:
- The default profile stdio-deepseek IS observably active (screenshots
  and CDP eval of `#profile.value` confirm)
- The guided-switch card renders correctly when the api-key error DOES
  reach the classifier (screenshot #02 proves this via the test seam)
- The static test suite (`test/default-profile-real.test.js` +
  `test/renderer-runtime-banner-classify.test.js`) locks every step of
  the wire path (currentProfileName, cfg.profile persistence, stderr
  accumulator, classification bucket, banner switch button)

## Follow-up

- **Dev-clone bump**: separate ticket. When `agent-spine-demo` becomes
  optional or the yml gains `workspaceContext`, re-run this probe in
  full to see the api-key error surface organically. Current 1554 test
  suite locks the code paths that would fire when it does.
- **README quick-start** — team-lead owns this batch, keeping just the
  minimum quote-of-fact edits to README in this commit (default is
  stdio-deepseek, keyless demo callout).
