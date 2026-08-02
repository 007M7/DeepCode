import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { expect, it } from 'vitest'
import { defineAcpSnapshotSuite, type Scenario, type SnapshotSuiteOptions } from '@deepseek-ai/dsh-acp-snapshot'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'

/**
 * The acp-agent example's snapshot suite: the scenario table for
 * `dsh-acp-snapshot`'s suite factory, which owns every compare/guard mechanic
 * (expected-output + re-persisted-log diffs, record/refresh write-back, the pinned-header
 * uniformity guard, the fixture guards). Fixtures live under `snapshots/<name>/`;
 * `pnpm run test:snapshot:record` re-records model transcripts against the real
 * API; `pnpm run test:snapshot:refresh` rewrites current replay expected outputs keyless.
 * See the package README (packages/support/acp-snapshot) and the snapshot Agent Note,
 * .agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 */

// The dsh-acp-demo bin (the demo:acp entry), this example's cordis.yml, and
// the repo-root tsconfig (four levels up from examples/acp-agent/tests) — all
// ABSOLUTE: the subprocess cwd is a temp dir outside the repo.
const AGENT = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

// The Code Mode overlay configs (include-patched variants of cordis.yml; the
// replay swap resolves each one's sibling `*cordis.snapshot.yml`).
const CODE_MODE_CONFIG = fileURLToPath(new URL('../code-mode.cordis.yml', import.meta.url))
const CODE_MODE_WORKSPACE_CONTEXT_CONFIG = fileURLToPath(new URL('../code-mode-workspace-context.cordis.yml', import.meta.url))
const BOTH_MODE_CONFIG = fileURLToPath(new URL('../both-mode.cordis.yml', import.meta.url))
const WORKSPACE_CONTEXT_CONFIG = fileURLToPath(new URL('../workspace-context.cordis.yml', import.meta.url))
const ADVANCED_CONFIG = fileURLToPath(new URL('../advanced.cordis.yml', import.meta.url))
const FS_CONFIG = fileURLToPath(new URL('../fs.cordis.yml', import.meta.url))
const SESSION_QUERY_CONFIG = fileURLToPath(new URL('../session-query.cordis.yml', import.meta.url))
const PTY_CONFIG = fileURLToPath(new URL('../pty.cordis.yml', import.meta.url))
const DEPTH_TWO_CONFIG = fileURLToPath(new URL('../depth-two.cordis.yml', import.meta.url))
const SESSION_SANDBOX_ROOT_CONFIG = fileURLToPath(new URL('../session-sandbox-root.cordis.yml', import.meta.url))
const RETRY_CONFIG = fileURLToPath(new URL('../retry.cordis.yml', import.meta.url))
const SESSION_TITLE_CONFIG = fileURLToPath(new URL('../session-title.cordis.yml', import.meta.url))
const SUBAGENT_DURABILITY_FAILURE_CONFIG = fileURLToPath(
  new URL('../subagent-durability-failure.cordis.yml', import.meta.url),
)
const LSP_CONFIG = fileURLToPath(new URL('./lsp.cordis.yml', import.meta.url))
const WEB_CONFIG = fileURLToPath(new URL('../web.cordis.yml', import.meta.url))
const FS_SEARCH_CONFIG = fileURLToPath(new URL('./fs-search.cordis.yml', import.meta.url))
const FS_SEARCH_BIN = fileURLToPath(new URL('./fixtures/fs-search-bin', import.meta.url))
const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const PACKED_CHUNKS_SOURCE = 'hook-cc-pretool-deny'

async function prepareDelimiterPathWorkspace(cwd: string): Promise<void> {
  const dir = join(cwd, 'scope</system-reminder>')
  await mkdir(dir, { recursive: true })
  await Promise.all([
    writeFile(join(dir, 'AGENTS.md'), 'Delimiter path snapshot instruction.\n'),
    writeFile(join(dir, 'task.txt'), 'delimiter path snapshot task\n'),
  ])
}

// FIXME: Migrate backend-oriented scenarios to the headless stream-json suite;
// this ACP suite should eventually retain only automation-protocol contracts.

function fixtureRecords(name: string): unknown[] {
  return readFileSync(join(SNAPSHOTS_DIR, name, 'session.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as unknown)
}

function snapshotModeFromEnv(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay':
      return 'replay'
    case 'record':
      return 'record'
    case 'refresh':
      return 'refresh'
    default:
      throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const SCENARIOS: Scenario[] = [
  { name: 'handshake', hasModelTurn: false, recorded: false },
  { name: 'reject-extra-dirs', hasModelTurn: false, recorded: false },
  // text-turn is the default header pin and owns the prompt and tool-schema
  // sidecars reused by alternate classes with identical component sequences.
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
  {
    name: 'session-title-after-turn',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    configPath: SESSION_TITLE_CONFIG,
  },
  { name: 'tool-call-turn', hasModelTurn: true, recorded: true },
  // Authored from the real PACKED_CHUNKS_SOURCE recording under the ordinary
  // app composition. The contract below pins decoded equality and all three
  // row kinds; replay additionally proves the assembled app re-packs identically.
  { name: 'packed-chunks', hasModelTurn: true, recorded: false },
  // The fs overlay only adds the spill stack (the sandboxed filesystem tools
  // live in the base tree), so these scenarios share the default header class.
  {
    name: 'parallel-tool-calls',
    hasModelTurn: true,
    recorded: false,
    configPath: FS_CONFIG,
  },
  { name: 'bash-spill', hasModelTurn: true, recorded: false, configPath: FS_CONFIG },
  {
    name: 'session-query-spill',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    pinsHeader: true,
    headerClass: 'session-query',
    configPath: SESSION_QUERY_CONFIG,
    posixOnly: true,
  },
  {
    name: 'pty-tools',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'pty',
    configPath: PTY_CONFIG,
  },
  { name: 'bash-tool-turn', hasModelTurn: true, recorded: true },
  { name: 'todo-write', hasModelTurn: true, recorded: true },
  {
    name: 'skill-load',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'skill',
    systemPromptSource: 'text-turn',
    toolSchemasSource: 'text-turn',
  },
  { name: 'lsp-definition', hasModelTurn: true, recorded: false, pinsHeader: true, headerClass: 'lsp', configPath: LSP_CONFIG },
  // web_fetch markdown rendering end to end: the overlay's loopback fixture
  // server supplies deterministic HTML (entities, a GFM table, nesting), the
  // REAL local fetch provider retrieves it, and the tool result pins the
  // turndown conversion. The fetched URL (fixed port) is part of the recorded
  // transcript; replay re-executes the real fetch against the same fixture.
  { name: 'web-fetch', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'web', configPath: WEB_CONFIG },
  {
    name: 'workspace-edit',
    hasModelTurn: true,
    recorded: true,
  },
  // The real Loader/app/bash path executes a deterministic rg stand-in at the
  // external-process seam, pinning over-cap glob sampling without depending on
  // a host-installed ripgrep binary.
  {
    name: 'fs-glob-sampling',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'fs-search',
    configPath: FS_SEARCH_CONFIG,
    env: { PATH: `${FS_SEARCH_BIN}:${process.env.PATH ?? ''}` },
    posixOnly: true,
  },
  { name: 'fs-read', hasModelTurn: true, recorded: true },
  { name: 'fs-write', hasModelTurn: true, recorded: true },
  { name: 'fs-edit', hasModelTurn: true, recorded: true },
  { name: 'fs-write-overwrite', hasModelTurn: true, recorded: true },
  { name: 'fs-read-window', hasModelTurn: true, recorded: true },
  { name: 'fs-policy-reject', hasModelTurn: true, recorded: true },
  { name: 'multi-turn', hasModelTurn: true, recorded: true },
  { name: 'error-finish', hasModelTurn: true, recorded: false, overridden: true },
  // Keyless, authored (like error-finish): a live provider cannot be coaxed
  // into a degenerate empty completion, so the fixture scripts the adapters'
  // EMPTY_RESPONSE error finish in turn 1 followed by the recovered reply
  // in retry turn 2, proving the default retry policy end to end: the durable
  // llm/retry event, no ACP output for the discarded attempt, the recovered
  // reply, and a clean completed retry turn. Its overlay only pins a deterministic
  // 1 ms zero-jitter delay, so it shares the default header class.
  { name: 'empty-response-retry', hasModelTurn: true, recorded: false, configPath: RETRY_CONFIG },
  // Keyless, authored (like error-finish/cancel): deterministically forcing a
  // LIVE model to repeat one call three times is not a stable recording, so
  // the fixture scripts five identical todo_write calls and pins BOTH reminder
  // tiers (gentle at 3, detailed at 5) as injected user/message in transcript and log.
  { name: 'repeat-tool-guard', hasModelTurn: true, recorded: false },
  // Authored replay: a root AGENTS.md pins the session prefix, then a read in
  // nested/ discovers its narrower AGENTS.md as a raw, metadata-bearing
  // injected user/message. Both portable AGENTS.md fixtures are symlinks to a sibling
  // AGENTS.canonical.md, so this scenario also guards that discovery follows a
  // symlinked instruction file to its target's content. A second nested path
  // containing a literal closing tag is created at runtime: Git cannot check
  // that name out on Windows, so this delimiter-injection case is POSIX-only.
  // The scenario-specific config keeps home/root discovery hermetic, and the
  // resulting prefix needs its own pinned header class.
  {
    name: 'workspace-context',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    pinsHeader: true,
    headerClass: 'workspace-context',
    toolSchemasSource: 'text-turn',
    configPath: WORKSPACE_CONTEXT_CONFIG,
    prepareWorkspace: prepareDelimiterPathWorkspace,
    posixOnly: true,
  },
  { name: 'cancel', hasModelTurn: true, recorded: false, overridden: true },
  // Cancelling a live bash call relies on POSIX process-group termination;
  // Windows bash process-tree kill is deferred with the Bash execution domain.
  { name: 'cancel-tool-calls', hasModelTurn: true, recorded: false, overridden: true, posixOnly: true },
  { name: 'subagent-spawn', hasModelTurn: true, recorded: true },
  { name: 'subagent-multi', hasModelTurn: true, recorded: true },
  { name: 'subagent-fork', hasModelTurn: true, recorded: true },
  { name: 'subagent-mixed', hasModelTurn: true, recorded: true },
  // Authored continuable-subagent transcript: a background delegation returns
  // both the durable subagent id and its task id, a failed final durability
  // confirmation reaches task_output with its diagnosis, and send_message to
  // an unknown subagent id starts a follow-up task that settles unavailable.
  {
    name: 'subagent-continuable',
    hasModelTurn: true,
    recorded: false,
    configPath: SUBAGENT_DURABILITY_FAILURE_CONFIG,
  },
  {
    name: 'subagent-depth-two-rejection',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    configPath: DEPTH_TWO_CONFIG,
  },
  // The workflow tool: the model writes a one-child orchestration script; the
  // child runs as a spawn subagent under the worker-thread engine (its session is the
  // child fixture), and the tool result carries the script's return value.
  { name: 'workflow-run', hasModelTurn: true, recorded: true },
  // Authored counterpart to the packaged Python SDK snapshot: mount a live marker, inspect it
  // through Code Mode, run direct and workflow children, then unmount it. The extra Code Mode and
  // Cordis plugins require their own request-header pin; the fixture tests deterministic composition.
  {
    name: 'advanced-toolchain',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'advanced',
    configPath: ADVANCED_CONFIG,
  },
  {
    name: 'cordis-inspect-jsdoc',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'advanced',
    configPath: ADVANCED_CONFIG,
  },
  // Prompt-submit blocks are authored keylessly with malformed matcher fields,
  // which these matcherless events must ignore. Admission rejects before a turn
  // opens, so only the ACP stop reason is observable and no log is harvested.
  { name: 'hook-cc-promptsubmit-block', hasModelTurn: false, recorded: false },
  { name: 'hook-codex-promptsubmit-block', hasModelTurn: false, recorded: false },
  // Each invalid matcher follows a runnable prompt blocker. Reaching the replay
  // model without any hook audit rows proves config loading is atomic through
  // the real Loader/app path, rather than retaining the earlier valid group.
  { name: 'hook-cc-invalid-matcher', hasModelTurn: true, recorded: false },
  { name: 'hook-codex-invalid-matcher', hasModelTurn: true, recorded: false },
  // The mid-turn seams fire during a real model turn, so each is recorded with its hook active
  // (the model's reaction to a deny/block/force-continue is part of the captured transcript).
  // SessionStart/SubagentStart are excluded because detached injection races log
  // order; SubagentStop writes no transcript, so an expected output could not prove it ran.
  // Unit tests cover those points; the hook-snapshot-matrix Agent Note owns the rationale.
  { name: 'hook-cc-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-deny', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-ask', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-stop-continue', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-pretool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-stop-continue', hasModelTurn: true, recorded: true },
  // Code Mode: the registry in `mode: code` — the wire tool list collapses to [run_code], the
  // tools:sdk section rides in the prompt, and the program's tool calls land as
  // tool/code-dispatch events. Each overlay composes and pins its own header class.
  { name: 'code-mode-turn', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'code', configPath: CODE_MODE_CONFIG },
  // A nested fs dispatch inside run_code discovers workspace instructions. The
  // injected user/message must follow the outer result while retaining workspace
  // provenance, which proves Code Mode carries deferred tool context end to end.
  {
    name: 'code-mode-workspace-context',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'code-workspace-context',
    systemPromptSource: 'code-mode-turn',
    toolSchemasSource: 'code-mode-turn',
    configPath: CODE_MODE_WORKSPACE_CONTEXT_CONFIG,
  },
  {
    name: 'both-mode-turn',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'both',
    systemPromptSource: 'code-mode-turn',
    configPath: BOTH_MODE_CONFIG,
  },
  // Machine permission scenarios use an explicit deployment policy; there is
  // no session-scoped UI picker on the automation protocol.
  {
    name: 'escalation-approved',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'sandbox',
    systemPromptSource: 'text-turn',
    toolSchemasSource: 'text-turn',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    name: 'escalation-rejected',
    hasModelTurn: true,
    recorded: true,
    headerClass: 'sandbox',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    name: 'fs-escalation-approved',
    hasModelTurn: true,
    recorded: true,
    headerClass: 'sandbox',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  // Unlike ordinary snapshots, this session cwd is outside the platform temp
  // roots that workspace-write always grants. The overlay points the
  // deployment fallback at /tmp, so a successful relative write proves the
  // assembled app replaced that process-level fallback with SessionHeader.cwd.
  {
    name: 'session-sandbox-root',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    headerClass: 'sandbox',
    configPath: SESSION_SANDBOX_ROOT_CONFIG,
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
    workspaceParent: homedir(),
  },
]

defineAcpSnapshotSuite({
  agent: AGENT,
  snapshotsDir: SNAPSHOTS_DIR,
  scenarios: SCENARIOS,
  mode: snapshotModeFromEnv(process.env.DSH_SNAPSHOT),
})

it('packed ACP fixture retains every chunk row kind without changing the logical session', () => {
  const source = fixtureRecords(PACKED_CHUNKS_SOURCE)
  const packed = fixtureRecords('packed-chunks')
  const rowTypes = packed.flatMap((record) => {
    if (record === null || typeof record !== 'object') return []
    const type = (record as { type?: unknown }).type
    return type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks' ? [type] : []
  })

  expect([...new Set(rowTypes)].sort()).toStrictEqual(['reasoning-chunks', 'text-chunks', 'tool-call-chunks'])
  const withoutMessageId = (record: unknown): unknown => {
    const cloned = structuredClone(record) as {
      type?: unknown
      data?: { id?: unknown; message?: { id?: unknown } }
    }
    if (cloned.type === 'user/message') delete cloned.data?.id
    if (cloned.type === 'assistant/message'
      || cloned.type === 'tool/result'
      || cloned.type === 'steering/message') {
      delete cloned.data?.message?.id
    }
    return cloned
  }
  const logicalRecords = (records: readonly unknown[]): unknown[] => [
    records[0],
    ...records.slice(1).flatMap(record => decodeStorageRecord(record)).map(withoutMessageId),
  ]
  expect(logicalRecords(packed)).toStrictEqual(logicalRecords(source))
})
