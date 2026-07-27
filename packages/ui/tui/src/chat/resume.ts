/**
 * Session-resume sub-controller for the interactive chat channel: the
 * `/resume` selector, per-candidate summary reads that tolerate a corrupt
 * neighbor, the pre-handoff preflight, the terminal handoff itself, and the
 * durable resume-hint command printed on exit.
 * @module @deepseek-ai/dsh-tui/chat/resume
 */

import type { TUI } from '@earendil-works/pi-tui'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  SessionLogSnapshot,
  SessionQueryService,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { HintEditor } from './helpers.ts'
import { formatCwd } from './helpers.ts'
import type { TuiOverlaySession } from '../extension/types.ts'
import type { TuiRuntime } from '../runtime.ts'
import type { Config } from '../config.ts'
import {
  ResumePicker,
  summarizeResumeCandidate,
  type ResumeCandidate,
} from '../components/dialogs.ts'
import type { ChannelNotice, ChatChannelDeps } from './channel.ts'

/** Collaborators the resume controller needs from the chat channel. */
export interface ResumeControllerDeps extends ChatChannelDeps, ChannelNotice {
  readonly agent: Agent
  readonly config: Config
  readonly runtime: TuiRuntime
  readonly persistence: SessionPersistence | undefined
  readonly sessionQuery: SessionQueryService | undefined
  readonly ui: TUI
  readonly editor: HintEditor
  /** Current agent status, re-read at each resume precondition point. */
  agentStatus(): AgentStatus
}

/** Session-resume controller for one chat channel. */
export interface ResumeController {
  /** Open the current-workspace searchable session selector. */
  showResume(): void
  /**
   * The resume command for the current session — the configured template with
   * every `{session}` filled — but only once the session is durably persisted;
   * `undefined` otherwise.
   */
  currentResumeCommand(): Promise<string | undefined>
}

/**
 * Build the session-resume controller for one chat channel.
 * @param deps - channel collaborators, terminal handles, and optional services.
 * @returns the controller wired to the `/resume` command and exit hint.
 */
export function createResumeController(deps: ResumeControllerDeps): ResumeController {
  const {
    ctx, agent, config, runtime, resolved, palette, overlayManager,
    persistence, sessionQuery, ui, editor,
  } = deps
  let resumeOverlay: TuiOverlaySession | undefined
  let resumeInFlight = false
  let resumeScan = 0

  /**
   * Persisted sessions for this workspace, newest first. Empty when no
   * persistence backend is mounted or a listing failure would otherwise block
   * exit or crash `/resume`; the resume hint is best-effort convenience.
   */
  const listWorkspaceSessions = async (): Promise<SessionHeader[]> => {
    if (persistence === undefined) return []
    let all: readonly SessionHeader[]
    try {
      all = await persistence.list()
    } catch {
      // A listing failure must never block terminal exit or crash `/resume`.
      return []
    }
    return all
      .filter(header => header.cwd === agent.session.header.cwd)
  }

  /** Build one display candidate without letting a corrupt neighbor abort the selector. */
  const readResumeCandidate = async (
    record: SessionRecord,
    providers: ReadonlySet<string>,
  ): Promise<ResumeCandidate> => {
    try {
      let snapshot: SessionLogSnapshot
      const live = ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        snapshot = {
          session: structuredClone(live.header),
          events: live.events.map(event => structuredClone(event)),
        }
      } else {
        /* v8 ignore next -- caller checks the optional service before mapping records */
        if (sessionQuery === undefined) throw new Error('session query is unavailable')
        snapshot = await sessionQuery.readSession(record.header.id)
      }
      return summarizeResumeCandidate(
        record,
        snapshot,
        agent.session.id,
        agent.session.header.cwd,
        providers,
      )
    } catch (error: unknown) {
      return {
        record,
        title: 'Unreadable session',
        lastActivityAt: record.header.createdAt,
        lastTurn: 'log unavailable',
        disabledReason: `session cannot be loaded: ${errorChain(error)}`,
      }
    }
  }

  /** Re-read every mutable precondition immediately before terminal handoff. */
  const preflightResume = async (sessionId: SessionId): Promise<ResumeCandidate> => {
    /* v8 ignore next -- only showResume can call this closure, after proving the optional service exists */
    if (sessionQuery === undefined) throw new Error('Resume is unavailable: session query is not mounted.')
    const initialStatus = deps.agentStatus()
    if (initialStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${initialStatus}).`)
    const record = (await sessionQuery.listSessions()).find(candidate => candidate.header.id === sessionId)
    if (record === undefined) throw new Error(`Session "${sessionId}" is no longer available.`)
    const candidate = await readResumeCandidate(
      record,
      new Set(ctx.llm.listProviders().map(provider => provider.id)),
    )
    if (candidate.disabledReason !== undefined) throw new Error(candidate.disabledReason)
    const finalStatus = deps.agentStatus()
    if (finalStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${finalStatus}).`)
    return candidate
  }

  const handoffResume = async (candidate: ResumeCandidate, overlay: TuiOverlaySession): Promise<void> => {
    if (resumeInFlight) return
    resumeInFlight = true
    let terminalReleased = false
    try {
      const checked = await preflightResume(candidate.record.header.id)
      const hostHandoff = runtime.handoffResume
      if (hostHandoff === undefined) {
        const template = config.resumeCommand
        const fallback = template?.replaceAll('{session}', checked.record.header.id)
        await overlay.close()
        resumeOverlay = undefined
        deps.appendNotice(fallback === undefined
          ? 'Session is resumable, but this host cannot hand it off in place.'
          : `This host cannot hand off in place. Exit and run: ${fallback}`, 'warning')
        return
      }
      /* v8 ignore next -- shutdown during preflight invalidates an awaited service read or reaches this guard */
      if (deps.isDisposed()) return
      await ctx.sessions.flush(agent.session)
      // Disposal can run while the flush promise is pending.
      if (deps.isDisposed()) return
      if (agent.status !== 'idle') throw new Error(`Resume requires an idle agent (status: ${agent.status}).`)
      await overlay.close()
      resumeOverlay = undefined
      await runtime.terminal.drainInput(100, 20)
      // Disposal can run while terminal draining is pending.
      if (deps.isDisposed()) return
      ui.stop()
      terminalReleased = true
      await hostHandoff(checked.record.header.id)
      throw new Error('resume host returned without replacing the process')
    } catch (error: unknown) {
      if (!deps.isDisposed()) {
        if (terminalReleased) {
          ui.start()
          ui.setFocus(editor)
          deps.appendNotice(`Resume handoff failed: ${errorChain(error)}`, 'error')
        } else {
          await overlay.close()
          resumeOverlay = undefined
          deps.appendNotice(`Resume failed: ${errorChain(error)}`, 'error')
        }
      }
    } finally {
      resumeInFlight = false
    }
  }

  return {
    currentResumeCommand: async (): Promise<string | undefined> => {
      if (config.resumeCommand === undefined) return undefined
      const sessions = await listWorkspaceSessions()
      if (!sessions.some(header => header.id === agent.session.id)) return undefined
      return config.resumeCommand.replaceAll('{session}', agent.session.id)
    },
    showResume(): void {
      if (agent.status !== 'idle') {
        deps.appendNotice('Resume requires the current turn to finish or be cancelled first.', 'warning')
        return
      }
      if (sessionQuery === undefined) {
        deps.appendNotice('Resume is not available: session query is not mounted.', 'warning')
        return
      }
      const scan = ++resumeScan
      void resumeOverlay?.close()
      void sessionQuery.listSessions().then(async (records) => {
        if (deps.isDisposed() || scan !== resumeScan) return
        const workspace = records.filter(record => record.header.cwd === agent.session.header.cwd)
        const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))
        const candidates = await Promise.all(workspace.map(record => readResumeCandidate(record, providers)))
        candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt
          || a.record.header.id.localeCompare(b.record.header.id))
        if (deps.isDisposed() || scan !== resumeScan) return
        const session = overlayManager.open({
          create: host => new ResumePicker(
            candidates,
            resolved.maxResumeOptions,
            runtime.formatCwd?.(agent.session.header.cwd) ?? formatCwd(agent.session.header.cwd),
            () => host.viewport.rows,
            palette,
            (candidate) => { void handoffResume(candidate, session) },
            () => { void session.close() },
          ),
          options: {
            width: '100%',
            maxHeight: '100%',
            anchor: 'top-left',
            margin: 0,
          },
        })
        resumeOverlay = session
        void session.closed.then(() => {
          /* v8 ignore next -- overlay FIFO closes this session before a replacement can become the tracked resume overlay */
          if (resumeOverlay === session) resumeOverlay = undefined
        })
        deps.requestRender()
      }, (error: unknown) => {
        if (!deps.isDisposed() && scan === resumeScan) deps.appendNotice(`Resume session scan failed: ${errorChain(error)}`, 'error')
      })
    },
  }
}
