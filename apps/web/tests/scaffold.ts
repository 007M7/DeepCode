// Shared scaffold for the keyless browser e2e lane (Agent Note:
// .agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).
// Boots the REAL web composition — the shipped base plus web overlay through
// the vendored Loader (the same include boot AppCLIEntry drives), patched the
// snapshot way — so a real chromium exercises the real HTTP/SSE wire, the
// api-gateway, agent loop, tools, and persistence. Modes ride $DSH_SNAPSHOT:
// replay (default, keyless: llm-deepseek row disabled, dsh-llm-replay row
// inserted in providers mode), record (real adapter + key, harvests fixtures
// from live session memory), refresh (keyless replay that rewrites goldens).
//
// Composition divergences from `dsh web`, all deliberate, all via include
// patches after the shipped surface overlay: temp persistenceRoot;
// workspace-context disabled (recorded fixtures must not embed this repo's
// AGENTS.md); session-title-llm disabled (its fire-and-forget title call
// would race the loop for the session's replay cursor); webserver pinned to
// port 0 with the built dist; keyless modes disable llm-deepseek and fill
// the open llm seam post-boot with installLlmReplay on the settled root ctx
// (the plugin-row path discards the ReplayHandle; the direct install keeps
// assertConsumed for the teardown fixture-consumption check).
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include, { type PatchOptions } from '@cordisjs/plugin-include'
import { scrubRequestHeaders } from '@deepseek-ai/dsh-acp-snapshot'
import { assertEntriesLoaded, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { ReplayHandle } from '@deepseek-ai/dsh-llm-replay'
import { installLlmReplay, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import SessionStore, {
  packChunkRuns,
  SESSION_FORMAT_VERSION,
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
// Empty type imports carry the httpServer/agents/sessionPersistence Context merges.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import { DIST_INDEX, REPO_ROOT, requireDist } from './support.ts'

/** Snapshot mode for the lane, from $DSH_SNAPSHOT (same vocabulary as the ACP/TUI suites). */
export type WebSnapshotMode = 'replay' | 'record' | 'refresh'

/**
 * Resolve and validate the lane's snapshot mode.
 * @returns the active mode; unset/empty selects replay.
 */
export function webSnapshotMode(): WebSnapshotMode {
  const value = process.env.DSH_SNAPSHOT
  if (value === undefined || value === '' || value === 'replay') return 'replay'
  if (value === 'record' || value === 'refresh') return value
  throw new Error(`DSH_SNAPSHOT must be replay, record, or refresh; got ${JSON.stringify(value)}`)
}

/** The shipped composition under test: apps/cli's shared base and web overlay. */
const CONFIG_PATH = join(REPO_ROOT, 'apps/cli/config/base.cordis.yml')
const WEB_OVERLAY_PATH = join(REPO_ROOT, 'apps/cli/config/web.cordis.yml')

// Replay publishes the provider catalog the gateway routes to (providers
// mode, never catch-all: with llm-deepseek disabled no adapter exists, so a
// catch-all would leave resolveModelInfo unroutable and compact-basic's
// post-step pressure check would warn every step). The published
// contextWindow keeps that pressure path provably inert for small fixtures.
const REPLAY_PROVIDERS = [{
  id: 'deepseek',
  name: 'DeepSeek',
  models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 }],
}]

/** A booted web scaffold: real composition, mode-selected model backend, temp world. */
export interface WebScaffold {
  /** The active snapshot mode this scaffold booted under. */
  mode: WebSnapshotMode
  /** Browser-facing origin (http://127.0.0.1:<bound port>). */
  baseUrl: string
  /** Settled root context (the in-process barrier seam; headless event subscription is its sanctioned use). */
  ctx: Context
  /** Temp project directory sessions run in (bash/fs tool cwd). */
  workspaceCwd: string
  /** Temp persistence root (seeded sessions land here through the real API). */
  persistenceRoot: string
  /** Await a settled turn end: in-process turn/end, then the agent's idle flip (which follows the persistence flush). */
  whenTurnSettled(timeoutMs?: number): Promise<SessionId>
  /** Tear everything down; asserts the replay fixture was fully consumed first (replay/refresh). */
  close(): Promise<void>
}

/** Options for {@link launchWebScaffold}. */
export interface LaunchOptions {
  /**
   * Replay fixture (session.jsonl) served by the inserted dsh-llm-replay row
   * in replay/refresh modes; ignored in record mode (the real adapter
   * answers). Omit for scenarios issuing no model calls — a stray stream then
   * fails loud with NO_ADAPTER (llm-deepseek is disabled and no replay row
   * mounts).
   */
  replayFixture?: string
  /**
   * Optional replay.override.json sidecar (whole-script replacement or
   * `{ patches }` augmentation) for throw/hang scenarios not expressible as
   * recorded chunks; replay/refresh only.
   */
  replayOverride?: string
  /** Per-chunk replay pacing (ms) so the browser observes genuinely incremental SSE; replay/refresh only. */
  paceMs?: number
  /**
   * Tool presentation mode patched onto the shipped `tools` row (`code`
   * collapses the wire to run_code + the SDK prompt section). Omit for the
   * yml default. The code runtime row is always in the tree, so no extra
   * insertion is needed.
   */
  toolsMode?: 'native' | 'code' | 'both'
  /**
   * Insert the opt-in self-referential Cordis tools into the shipped tree.
   * Record and replay use the same tool surface, so captured request headers
   * remain reconstructable without making the tools a product default.
   */
  cordisTools?: boolean
}

/** Dispose the booted tree and remove both owned temp roots, reporting every independent cleanup failure. */
async function cleanupScaffoldWorld(ctx: Context, workspaceCwd: string, persistenceRoot: string): Promise<unknown[]> {
  const failures: unknown[] = []
  await Promise.resolve(ctx.fiber.dispose()).catch((error: unknown) => failures.push(error))
  await rm(workspaceCwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  await rm(persistenceRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  return failures
}

/**
 * Boot the real web composition under the current snapshot mode.
 * @param options - replay fixture selection and pacing.
 * @returns the running scaffold.
 */
export async function launchWebScaffold(options: LaunchOptions = {}): Promise<WebScaffold> {
  requireDist()
  const mode = webSnapshotMode()
  if (mode === 'record') {
    // Both owning vitest configs (web unconditionally, snapshot in record
    // mode) load the repo-root .env before this file runs.
    if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.length === 0) {
      throw new Error('web e2e record mode needs DEEPSEEK_API_KEY (env or repo-root .env)')
    }
  }
  const workspaceCwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-e2e-ws-')))
  let persistenceRoot: string
  try {
    persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-sessions-'))
  } catch (error) {
    const failures: unknown[] = [error]
    await rm(workspaceCwd, { recursive: true, force: true }).catch((cleanupError: unknown) => failures.push(cleanupError))
    if (failures.length > 1) throw new AggregateError(failures, 'web scaffold temp-root setup failed')
    throw error
  }

  // The include patch set — the same mechanism AppCLIEntry and the ACP
  // snapshot overlay use, applied over the SAME shipped tree (a patch id that
  // stops matching a row fails the boot sweep loudly instead of drifting).
  const surfacePatches = loadOverlayPatches('web e2e scaffold', WEB_OVERLAY_PATH)
  const patches: PatchOptions[] = [
    ...surfacePatches,
    { id: 'session-persistence-jsonl', config: { root: persistenceRoot } },
    // storage-json's './.storages' yml default is cwd-relative and resolves
    // per write; the scaffold restores the original cwd after boot, so the
    // row gets an absolute temp root (removed with the workspace at close).
    { id: 'storage-json', config: { root: join(workspaceCwd, '.dsh-storages') } },
    // fs/bash cwd default to process.cwd(); the gateway injects the same
    // value into session.cwd — chdir below anchors all three to the temp
    // workspace, keeping the composition untouched.
    { id: 'workspace-context', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'webserver', config: { host: '127.0.0.1', port: 0, distIndex: DIST_INDEX } },
    // The shipped directory-picker row is the -auto chooser, which resolves
    // the interaction from the RUNNING host (display, SSH launch, bind). The
    // lane's goldens are interaction-specific (workspace-management drives
    // the in-app browse dialog), so pin -browse deterministically on every
    // host: patch `name` is an assertion, not an override, hence the
    // disable+insert pair.
    { id: 'directory-picker', disabled: true },
    { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }] },
    ...options.toolsMode === undefined ? [] : [{ id: 'tools', config: { mode: options.toolsMode } }],
    ...options.cordisTools === true
      ? [{ insert: [{ id: 'tool-cordis', name: 'cordis:tool-cordis' }] }]
      : [],
    ...mode === 'record' ? [] : [{ id: 'llm-deepseek', disabled: true }],
  ]

  // Sessions inherit the gateway's process.cwd() default; run the boot from
  // the temp workspace so tool cwd, session cwd, and fixtures agree.
  const originalCwd = process.cwd()
  const ctx = new Context()
  let port = 0
  let replayHandle: ReplayHandle | undefined
  try {
    process.chdir(workspaceCwd)
    ctx.baseUrl = pathToFileURL(join(resolve(CONFIG_PATH), '..')).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    // The shipped CLI deliberately has no dependency on this opt-in package.
    // Keep the Loader row real without broadening the product installation.
    if (options.cordisTools === true) ctx.loader.builtins['tool-cordis'] = ToolCordis
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(resolve(CONFIG_PATH)).href, patches },
    })
    await ctx.loader.await()
    assertEntriesLoaded(ctx, 'web e2e scaffold')
    const boundPort = ctx.get('httpServer')?.port
    if (boundPort === undefined) {
      throw new Error('web e2e scaffold: httpServer service missing after settled boot')
    }
    port = boundPort

    // Fill the open llm seam on the settled root ctx (llm-deepseek is disabled
    // in keyless modes; a scenario with no fixture leaves the seam empty so a
    // stray stream fails loud with NO_ADAPTER). The direct install, unlike the
    // plugin row, returns the ReplayHandle for the teardown consumption check.
    if (mode !== 'record' && options.replayFixture !== undefined) {
      replayHandle = installLlmReplay(ctx, {
        file: options.replayFixture,
        providers: REPLAY_PROVIDERS,
        ...(options.replayOverride === undefined ? {} : { overrideFile: options.replayOverride }),
        ...(options.paceMs === undefined ? {} : { paceMs: options.paceMs }),
      })
    }
  } catch (error) {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd)
    const cleanupFailures = await cleanupScaffoldWorld(ctx, workspaceCwd, persistenceRoot)
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'web scaffold setup failed and cleanup was incomplete')
    }
    throw error
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd)
  }

  return {
    mode,
    baseUrl: `http://127.0.0.1:${port}`,
    ctx,
    workspaceCwd,
    persistenceRoot,
    // Barrier stack: the in-process turn/end identifies the session, then
    // agent.whenIdle() covers the persistence flush (the idle flip follows
    // the flush), and the caller's browser settled-poll comes last because
    // host completion strictly precedes render.
    whenTurnSettled(timeoutMs = mode === 'record' ? 180_000 : 30_000): Promise<SessionId> {
      return new Promise<SessionId>((resolveSettled, reject) => {
        const timer = setTimeout(() => {
          off()
          reject(new Error(`no turn/end within ${timeoutMs}ms`))
        }, timeoutMs)
        const off = ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
          if (event.type !== 'turn/end') return
          clearTimeout(timer)
          off()
          const agent = ctx.agents.get(session.id)
          if (agent === undefined) {
            reject(new Error(`turn/end for ${session.id} but no live agent`))
            return
          }
          agent.whenIdle().then(() => { resolveSettled(session.id) }, reject)
        })
      })
    },
    async close(): Promise<void> {
      const failures: unknown[] = []
      // Fixture-consumption check first, while the run's binding state is
      // still authoritative — a scenario that drove fewer model calls than
      // recorded fails here instead of drifting green.
      try {
        replayHandle?.assertConsumed()
      } catch (error) {
        failures.push(error)
      }
      failures.push(...await cleanupScaffoldWorld(ctx, workspaceCwd, persistenceRoot))
      if (failures.length > 0) throw new AggregateError(failures, 'web scaffold teardown failed')
    },
  }
}

/**
 * Serialize a live session to the canonical raw session-JSONL layout — the
 * in-memory record-mode harvest, so the on-disk zstd default never matters.
 */
function rawSessionLog(session: Session): string {
  return [
    JSON.stringify({ type: 'session', ...session.header }),
    ...packChunkRuns(session.events).map(record => JSON.stringify(record)),
    '',
  ].join('\n')
}

/**
 * Record-mode fixture write-back: harvest the live session, scrub request
 * headers to {{system}}/{{tools}} (TODO(web-header-pin): the web lane pins no
 * header class — a deliberate deviation logged in the Agent Note's deferred
 * work), tokenize the run-local session id, cwd, and browser RPC id
 * ({{sessionId}}/{{cwd}}/{{rpcId}}, the committed fixture convention —
 * re-records then diff only on real content), and write the fixture.
 * @param scaffold - the record-mode scaffold.
 * @param sessionId - the driven session.
 * @param fixturePath - the committed session.jsonl / seed.jsonl target.
 */
export async function recordFixture(scaffold: WebScaffold, sessionId: SessionId, fixturePath: string): Promise<void> {
  const agent = scaffold.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`record harvest: no live agent for ${sessionId}`)
  const tokenized = scrubRequestHeaders(rawSessionLog(agent.session))
    .split(sessionId).join('{{sessionId}}')
    .split(scaffold.workspaceCwd).join('{{cwd}}')
    .replace(/"rpcId":"[^"]+"/g, '"rpcId":"{{rpcId}}"')
  await writeFile(fixturePath, tokenized)
}

/**
 * The user prompts recorded in a fixture, in order — the single source tying
 * spec drive steps to recorded reality so script and fixture cannot drift.
 * @param fixtureText - raw session.jsonl contents.
 * @returns the recorded user prompt texts.
 */
export function fixtureUserPrompts(fixtureText: string): string[] {
  return parseSessionLog(fixtureText).flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
    const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    return text.length > 0 ? [text] : []
  })
}

/**
 * Seed a recorded session fixture into the scaffold's persistence root
 * through the REAL backend API (throwaway Context + SessionStore + JSONL
 * plugin — the semantic-checkpoint precedent), never raw file writes: no
 * knowledge of bucket hashing, filename encoding, or compression, and
 * malformed shapes fail loud at seed time. The fixture's tokenized identity
 * ({{sessionId}}/{{cwd}}) is realized for this world before parsing.
 * @param scaffold - the target scaffold.
 * @param fixtureText - raw recorded session.jsonl contents.
 * @param id - the seeded session id (stable for deterministic goldens).
 * @returns the seeded id.
 */
export async function seedSession(scaffold: WebScaffold, fixtureText: string, id: string): Promise<SessionId> {
  const realized = fixtureText
    .split('{{sessionId}}').join(id)
    .split('{{cwd}}').join(scaffold.workspaceCwd)
  const fixtureCwd = (JSON.parse(realized.split('\n', 1)[0]!) as { cwd?: string }).cwd
  const rewritten = fixtureCwd === undefined
    ? realized
    : realized.split(fixtureCwd).join(scaffold.workspaceCwd)
  const events = parseSessionLog(rewritten)
  if (events.length === 0) throw new Error('seed fixture has no events')
  const last = events[events.length - 1]!
  // An open final turn would be mutated by resume's crash repair on first
  // open; a committed seed must be a closed recording.
  if (last.type !== 'turn/end') throw new Error(`seed fixture must end in turn/end, got ${last.type}`)
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now() - 60_000,
    cwd: scaffold.workspaceCwd,
    delegationDepth: 0,
  }
  const seeder = new Context()
  try {
    await seeder.plugin(SessionStore)
    // Same root as the booted tree with the plugin's own default compression,
    // so the host's directory-scan list() sees one consistent encoding.
    await seeder.plugin(SessionPersistenceJsonl, { root: scaffold.persistenceRoot })
    await seeder.sessionPersistence.create(meta)
    await seeder.sessionPersistence.append(meta.id, events)
    // Deterministic sidebar order: cold summaries take updatedAt from mtime.
    const located = seeder.sessionPersistence.locate(meta)
    if (located !== undefined) {
      const backdated = new Date(meta.createdAt)
      await utimes(located.path, backdated, backdated)
    }
  } finally {
    await seeder.fiber.dispose()
  }
  return meta.id
}

/**
 * Normalize an aria snapshot: uuid, cwd, workspace-basename, and duration
 * volatility collapse to stable tokens.
 */
function normalizeAria(snapshot: string, workspaceCwd: string): string {
  // The header breadcrumb renders the workspace's basename, not the full
  // path, so both spellings must collapse to the token.
  const base = workspaceCwd.split('/').pop()!
  return snapshot
    .split(workspaceCwd).join('{{cwd}}')
    .split(base).join('{{workspace}}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{{uuid}}')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|秒)\b/g, '{{duration}}')
    // Message IconActions clocks widen by calendar day/year; collapse every
    // shape so goldens stay stable across midnight and year boundaries.
    .replace(/\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/(?<!\d)\d{2}:\d{2}(?!\d)/g, '{{clock}}')
}

/**
 * Capture the region's aria snapshot at a settled milestone: poll until two
 * consecutive normalized captures are equal — a single-shot capture races the
 * last React commits.
 * @param page - the page under test.
 * @param selector - the region locator selector.
 * @param workspaceCwd - normalization input.
 * @returns the stable normalized snapshot.
 */
export async function captureStableAria(page: Page, selector: string, workspaceCwd: string): Promise<string> {
  const region = page.locator(selector).first()
  let previous = normalizeAria(await region.ariaSnapshot(), workspaceCwd)
  await expect.poll(async () => {
    const current = normalizeAria(await region.ariaSnapshot(), workspaceCwd)
    const stable = current === previous
    previous = current
    return stable
  }, { timeout: 5_000, message: 'aria snapshot did not stabilize' }).toBe(true)
  return previous
}

/**
 * Compare a normalized golden, or rewrite it under refresh. Refresh is the
 * ONLY writer: a missing golden in replay mode fails with the healing command
 * instead of silently self-bootstrapping.
 * @param goldenPath - the committed ui.expected.md path.
 * @param actual - the stable normalized snapshot.
 * @param mode - the active snapshot mode.
 */
export async function compareOrRefreshGolden(goldenPath: string, actual: string, mode: WebSnapshotMode): Promise<void> {
  const payload = `${actual}\n`
  if (mode === 'refresh') {
    await writeFile(goldenPath, payload)
    return
  }
  if (!existsSync(goldenPath)) {
    throw new Error(`missing golden ${goldenPath} — run DSH_SNAPSHOT=refresh pnpm run test:web to generate it`)
  }
  expect(payload).toBe(await readFile(goldenPath, 'utf8'))
}

/**
 * Fixture-inventory guard (the TUI afterAll shape): the scenario directory
 * holds exactly the expected files and every committed JSONL is a scrub
 * fixed-point without a run-local browser RPC id.
 * @param dir - the scenario snapshot directory.
 * @param expected - the exact expected file inventory.
 */
export async function assertFixtureInventory(dir: string, expected: string[]): Promise<void> {
  const entries = (await readdir(dir)).sort()
  expect(entries).toEqual([...expected].sort())
  for (const entry of entries.filter(name => name.endsWith('.jsonl'))) {
    const content = await readFile(join(dir, entry), 'utf8')
    expect(scrubRequestHeaders(content), `${dir}/${entry} carries request-header bulk`).toBe(content)
    expect(content, `${dir}/${entry} carries a run-local rpcId`)
      .not.toMatch(/"rpcId":"(?!\{\{rpcId\}\})[^"]+"/)
  }
}

/**
 * Console tripwires: reconnect/gap-repair self-healing or a pageerror must
 * fail the scenario, not mask a dead wire behind eventual consistency.
 * @param page - the page under test.
 * @returns live warning/pageerror collectors to assert empty at scenario end.
 */
export function watchConsole(page: Page): { warnings: string[]; pageErrors: string[] } {
  const warnings: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/connection lost|gap repair|discontinuous/i.test(text)) warnings.push(text)
  })
  page.on('pageerror', (error) => { pageErrors.push(String(error)) })
  return { warnings, pageErrors }
}

/**
 * Remove only connection-loss warnings emitted after an intentional reload.
 * Earlier warnings and all gap-repair/discontinuity warnings remain fatal.
 * @param tripwire - the live console-warning collector.
 * @param warningStart - warning count captured immediately before reloading.
 */
export function acknowledgeReloadConnectionLoss(
  tripwire: ReturnType<typeof watchConsole>,
  warningStart: number,
): void {
  const reloadWarnings = tripwire.warnings.splice(warningStart)
  tripwire.warnings.push(...reloadWarnings.filter(text => !/connection lost/i.test(text)))
}
