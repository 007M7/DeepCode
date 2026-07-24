// Shared harness for the keyless browser e2e lane (Agent Note:
// .agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).
// Boots the REAL web assembly in-process from the exported production
// functions — startHost (bootHost spine) + mountWebPlugins + registry +
// startWebServer — so a real chromium exercises the real HTTP/SSE wire,
// apiproxy, agent loop, tools, and persistence. Modes ride $DSH_SNAPSHOT:
// replay (default, keyless: `llm: false` + dsh-llm-replay in providers mode),
// record (real DeepSeek adapter + key, harvests fixtures from live session
// memory), refresh (keyless replay that rewrites the committed goldens).
//
// Assembly divergence from `dsh web` (apps/cli/src/web.ts), deliberate: the
// shipped shell opts into sessionTitleLlm, whose fire-and-forget title call
// shares the session's replay cursor — nondeterministic ordering against the
// loop's own calls — so this lane keeps bootHost's disabled default and
// sidebar titles come from the deterministic fallback service.
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import { scrubRequestHeaders } from '@deepseek-ai/dsh-acp-snapshot'
import { installLlmReplay, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { ReplayHandle } from '@deepseek-ai/dsh-llm-replay'
import { startHost, mountWebPlugins } from '@deepseek-ai/dsh-host-runtime'
import type { RunningHost } from '@deepseek-ai/dsh-host-runtime'
import { createHostWebPluginRegistry, startWebServer } from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Context } from 'cordis'
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

// Replay must run in providers mode (never catch-all): with `llm: false` no
// adapter exists, so a catch-all would leave resolveModelContext unroutable
// and compact-basic's post-step pressure check would warn every step. The
// published contextWindow keeps that pressure path provably inert for small
// fixtures.
const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000 }] }]

// The shipped client roster (apps/cli/src/web.ts CLIENT_PACKAGES, sans the
// --dev HMR row). apps/web depends on every entry, so its URL anchors the
// Loader's bare-specifier resolution.
const CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-i18n',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-question',
  '@deepseek-ai/dsh-client-ui-trajectory',
] as const

/** Repo-root .env → process.env for record mode (never overrides set vars); the smoke-real convention. */
function loadRootEnv(): void {
  const envPath = join(REPO_ROOT, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (m !== null && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]
  }
}

/** A booted web harness: real assembly, mode-selected model backend, temp world. */
export interface WebHarness {
  /** The active snapshot mode this harness booted under. */
  mode: WebSnapshotMode
  /** Browser-facing origin (http://127.0.0.1:<bound port>). */
  baseUrl: string
  /** The running host (ctx is the documented in-process barrier seam). */
  host: RunningHost
  /** Temp project directory sessions run in (bash/fs tool cwd). */
  workspaceCwd: string
  /** Temp persistence root (seeded sessions land here through the real API). */
  persistenceRoot: string
  /** Errors the web server reported asynchronously; assert empty at scenario end. */
  serverErrors: string[]
  /** Await a settled turn end: in-process turn/end, then the agent's idle flip (which follows the persistence flush). */
  whenTurnSettled(timeoutMs?: number): Promise<SessionId>
  /** Tear everything down; asserts the replay fixture was fully consumed first (replay/refresh). */
  close(): Promise<void>
}

/** Options for {@link launchWebHarness}. */
export interface LaunchOptions {
  /**
   * Replay fixture (session.jsonl) served by dsh-llm-replay in replay/refresh
   * modes; ignored in record mode (the real adapter answers). Omit for
   * scenarios issuing no model calls — a stray stream then fails loud with
   * NO_ADAPTER on the open seam.
   */
  replayFixture?: string
  /** Per-chunk replay pacing (ms) so the browser observes genuinely incremental SSE; replay/refresh only. */
  paceMs?: number
}

/**
 * Boot the real web assembly under the current snapshot mode.
 * @param options - replay fixture selection and pacing.
 * @returns the running harness.
 */
export async function launchWebHarness(options: LaunchOptions = {}): Promise<WebHarness> {
  requireDist()
  const mode = webSnapshotMode()
  if (mode === 'record') {
    loadRootEnv()
    if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.length === 0) {
      throw new Error('web e2e record mode needs DEEPSEEK_API_KEY (env or repo-root .env)')
    }
  }
  const workspaceCwd = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-ws-'))
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-sessions-'))
  const serverErrors: string[] = []
  let host: RunningHost | undefined
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined
  let replay: ReplayHandle | undefined
  try {
    host = await startHost({
      boot: {
        persistenceRoot,
        // Keep the request header free of ambient AGENTS.md content so
        // recorded fixtures do not embed this repo's instructions.
        workspaceContext: false,
        cwd: workspaceCwd,
        // Replay/refresh boot keyless with the llm seam open; record mounts
        // the real adapter and performs real provider I/O.
        ...(mode === 'record' ? {} : { llm: false as const }),
      },
    })
    if (mode !== 'record' && options.replayFixture !== undefined) {
      replay = installLlmReplay(host.ctx, {
        file: options.replayFixture,
        providers: PROVIDERS,
        ...(options.paceMs === undefined ? {} : { paceMs: options.paceMs }),
      })
    }
    // Anchor at apps/cli exactly as `dsh web` does: that package declares
    // every roster entry as a dependency, so the Loader's bare-specifier
    // resolution and the registry's package.json resolver both work.
    const anchor = pathToFileURL(join(REPO_ROOT, 'apps/cli/src/web.ts')).href
    const mounted = await mountWebPlugins(host.ctx, CLIENT_PACKAGES, anchor)
    const webPlugins = createHostWebPluginRegistry({
      ctx: host.ctx,
      loader: mounted.loader,
      resolvePkgJson: mounted.resolvePkgJson,
      onError: (err: Error) => { serverErrors.push(String(err)) },
    })
    server = await startWebServer(
      { host: '127.0.0.1', port: 0, distIndex: DIST_INDEX, apiHandler: host.handler, webPlugins },
      (err: Error) => { serverErrors.push(String(err)) },
    )
  } catch (error) {
    await server?.close().catch(() => undefined)
    await host?.dispose().catch(() => undefined)
    await rm(workspaceCwd, { recursive: true, force: true }).catch(() => undefined)
    await rm(persistenceRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  const runningHost = host
  const runningServer = server
  const replayHandle = replay

  return {
    mode,
    baseUrl: `http://127.0.0.1:${server.port}`,
    host,
    workspaceCwd,
    persistenceRoot,
    serverErrors,
    // Barrier stack: the in-process turn/end identifies the session, then
    // agent.whenIdle() covers the persistence flush (the idle flip follows
    // the flush), and the caller's browser settled-poll comes last because
    // host completion strictly precedes render.
    whenTurnSettled(timeoutMs = mode === 'record' ? 180_000 : 30_000): Promise<SessionId> {
      return new Promise<SessionId>((resolve, reject) => {
        const timer = setTimeout(() => {
          off()
          reject(new Error(`no turn/end within ${timeoutMs}ms`))
        }, timeoutMs)
        const off = runningHost.ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
          if (event.type !== 'turn/end') return
          clearTimeout(timer)
          off()
          const agent = runningHost.ctx.agents.get(session.id)
          if (agent === undefined) {
            reject(new Error(`turn/end for ${session.id} but no live agent`))
            return
          }
          agent.whenIdle().then(() => { resolve(session.id) }, reject)
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
      await runningServer.close().catch((e: unknown) => failures.push(e))
      await runningHost.dispose().catch((e: unknown) => failures.push(e))
      await rm(workspaceCwd, { recursive: true, force: true }).catch((e: unknown) => failures.push(e))
      await rm(persistenceRoot, { recursive: true, force: true }).catch((e: unknown) => failures.push(e))
      if (failures.length > 0) throw new AggregateError(failures, 'web harness teardown failed')
    },
  }
}

/**
 * Serialize a live session back to raw session-JSONL (header + events) — the
 * in-memory record-mode harvest, so the on-disk zstd default never matters.
 * Mirrors the TUI suite's rawSessionLog.
 * @param session - the live session to serialize.
 * @returns raw JSONL text ending in one newline.
 */
export function rawSessionLog(session: Session): string {
  return [
    JSON.stringify({ type: 'session', ...session.header }),
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

/**
 * Record-mode fixture write-back: harvest the live session, scrub request
 * headers to {{system}}/{{tools}} (the web lane pins no header class — a
 * deliberate deviation logged in the Agent Note's deferred work), tokenize
 * the run-local session id and cwd ({{sessionId}}/{{cwd}}, the committed ACP
 * fixture convention — re-records then diff only on real content), and write
 * the committed fixture.
 * @param harness - the record-mode harness.
 * @param sessionId - the driven session.
 * @param fixturePath - the committed session.jsonl / seed.jsonl target.
 */
export async function recordFixture(harness: WebHarness, sessionId: SessionId, fixturePath: string): Promise<void> {
  const agent = harness.host.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`record harvest: no live agent for ${sessionId}`)
  const tokenized = scrubRequestHeaders(rawSessionLog(agent.session))
    .split(sessionId).join('{{sessionId}}')
    .split(harness.workspaceCwd).join('{{cwd}}')
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
 * Seed a recorded session fixture into the harness's persistence root through
 * the REAL backend API (throwaway Context + SessionStore + JSONL plugin — the
 * semantic-checkpoint precedent), never raw file writes: no knowledge of
 * bucket hashing, filename encoding, or compression, and malformed shapes
 * fail loud at seed time. The fixture's recorded cwd is rewritten to the
 * harness workspace so header/path identity and event payload paths agree.
 * @param harness - the target harness.
 * @param fixtureText - raw recorded session.jsonl contents.
 * @param id - the seeded session id (stable for deterministic goldens).
 * @returns the seeded id.
 */
export async function seedSession(harness: WebHarness, fixtureText: string, id: string): Promise<SessionId> {
  // Committed fixtures tokenize run-local identity ({{sessionId}}/{{cwd}},
  // written by recordFixture); realize both for this world before parsing.
  const realized = fixtureText
    .split('{{sessionId}}').join(id)
    .split('{{cwd}}').join(harness.workspaceCwd)
  const fixtureCwd = (JSON.parse(realized.split('\n', 1)[0]!) as { cwd?: string }).cwd
  const rewritten = fixtureCwd === undefined
    ? realized
    : realized.split(fixtureCwd).join(harness.workspaceCwd)
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
    cwd: harness.workspaceCwd,
    delegationDepth: 0,
  }
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    // Same root as the host with the plugin's own default compression, so the
    // host's directory-scan list() sees one consistent encoding.
    await ctx.plugin(SessionPersistenceJsonl, { root: harness.persistenceRoot })
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(meta.id, events)
    // Deterministic sidebar order: cold summaries take updatedAt from mtime.
    const located = ctx.sessionPersistence.locate(meta)
    if (located !== undefined) {
      const backdated = new Date(meta.createdAt)
      await utimes(located.path, backdated, backdated)
    }
  } finally {
    await ctx.fiber.dispose()
  }
  return meta.id
}

/**
 * Normalize an aria snapshot: uuid, cwd, workspace-basename, and duration
 * volatility collapse to stable tokens.
 * @param snapshot - raw ariaSnapshot text.
 * @param workspaceCwd - the harness workspace (basename doubles as the header breadcrumb).
 * @returns tokenized snapshot text.
 */
export function normalizeAria(snapshot: string, workspaceCwd: string): string {
  // The header breadcrumb renders the workspace's basename, not the full
  // path, so both spellings must collapse to the token.
  const base = workspaceCwd.split('/').pop()!
  return snapshot
    .split(workspaceCwd).join('{{cwd}}')
    .split(base).join('{{workspace}}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{{uuid}}')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|秒)\b/g, '{{duration}}')
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
 * fixed-point (no request-header bulk escaped the record write-back).
 * @param dir - the scenario snapshot directory.
 * @param expected - the exact expected file inventory.
 */
export async function assertFixtureInventory(dir: string, expected: string[]): Promise<void> {
  const entries = (await readdir(dir)).sort()
  expect(entries).toEqual([...expected].sort())
  for (const entry of entries.filter(name => name.endsWith('.jsonl'))) {
    const content = await readFile(join(dir, entry), 'utf8')
    expect(scrubRequestHeaders(content), `${dir}/${entry} carries request-header bulk`).toBe(content)
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
