/**
 * Session-resume sub-controller for the interactive chat channel: the
 * `/resume` selector, per-candidate summary reads that tolerate a corrupt
 * neighbor, the pre-handoff preflight, and the terminal handoff itself.
 * @module @deepseek-ai/dsh-tui/chat/resume
 */

import type { TUI } from '@earendil-works/pi-tui'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionLogSnapshot,
  SessionQueryService,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type { HintEditor } from './helpers.ts'
import { formatCwd } from './helpers.ts'
import type { TuiOverlaySession } from '../extension/types.ts'
import type { TuiRuntime } from '../runtime.ts'
import {
  ResumePicker,
  summarizeResumeCandidate,
  type ResumeCandidate,
} from '../components/dialogs.ts'
import type { ChannelNotice, ChatChannelDeps } from './channel.ts'

/** Collaborators the resume controller needs from the chat channel. */
export interface ResumeControllerDeps extends ChatChannelDeps, ChannelNotice {
  readonly agent: Agent
  readonly runtime: TuiRuntime
  /**
   * The optional session-query service, re-read at each use. `sessionQuery` is
   * mounted by an independent plugin, and a flat config tree gives no ordering
   * guarantee between it and this front door, so a value captured once at
   * construction can be `undefined` even though the service arrives moments later.
   */
  readonly sessionQuery: (this: void) => SessionQueryService | undefined
  readonly ui: TUI
  readonly editor: HintEditor
  /** Current agent status, re-read at each resume precondition point. */
  agentStatus(): AgentStatus
}

/** Session-resume controller for one chat channel. */
export interface ResumeController {
  /** Open the searchable session selector, scoped to this workspace until the user widens it. */
  showResume(): void
}

/**
 * Build the session-resume controller for one chat channel.
 * @param deps - channel collaborators, terminal handles, and optional services.
 * @returns the controller wired to the `/resume` command.
 */
export function createResumeController(deps: ResumeControllerDeps): ResumeController {
  const {
    ctx, agent, runtime, resolved, palette, overlayManager,
    sessionQuery, ui, editor,
  } = deps
  let resumeOverlay: TuiOverlaySession | undefined
  let resumeInFlight = false
  let resumeScan = 0

  /** Label any session's own workspace the way the prompt labels the current one. */
  const workspaceLabel = (cwd: string | undefined): string =>
    runtime.formatCwd?.(cwd) ?? formatCwd(cwd)

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
        const readQuery = sessionQuery()
        /* v8 ignore start -- caller proves the optional service before mapping records */
        if (readQuery === undefined) throw new Error('session query is unavailable')
        /* v8 ignore stop */
        snapshot = await readQuery.readSession(record.header.id)
      }
      return summarizeResumeCandidate(
        record,
        snapshot,
        agent.session.id,
        agent.session.header.cwd,
        providers,
        workspaceLabel,
      )
    } catch (error: unknown) {
      return {
        record,
        title: 'Unreadable session',
        lastActivityAt: record.header.createdAt,
        lastTurn: 'log unavailable',
        currentWorkspace: record.header.cwd === agent.session.header.cwd,
        workspaceLabel: workspaceLabel(record.header.cwd),
        disabledReason: `session cannot be loaded: ${errorChain(error)}`,
      }
    }
  }

  /**
   * Re-read every mutable precondition immediately before terminal handoff and
   * resolve the exact identity and workspace the host will re-exec into.
   */
  const preflightResume = async (sessionId: SessionId): Promise<{ id: SessionId; cwd: string }> => {
    const query = sessionQuery()
    /* v8 ignore start -- showResume alone calls this after proving the optional service exists */
    if (query === undefined) throw new Error('Resume is unavailable: session query is not mounted.')
    /* v8 ignore stop */
    const initialStatus = deps.agentStatus()
    if (initialStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${initialStatus}).`)
    const record = (await query.listSessions()).find(candidate => candidate.header.id === sessionId)
    if (record === undefined) throw new Error(`Session "${sessionId}" is no longer available.`)
    const candidate = await readResumeCandidate(
      record,
      new Set(ctx.llm.listProviders().map(provider => provider.id)),
    )
    if (candidate.disabledReason !== undefined) throw new Error(candidate.disabledReason)
    const cwd = candidate.record.header.cwd
    /* v8 ignore next -- summarizeResumeCandidate disables a cwd-less record, so the check above already rejected it */
    if (cwd === undefined) throw new Error(`Session "${sessionId}" has no recorded workspace to resume in.`)
    const finalStatus = deps.agentStatus()
    if (finalStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${finalStatus}).`)
    return { id: candidate.record.header.id, cwd }
  }

  const handoffResume = async (candidate: ResumeCandidate, overlay: TuiOverlaySession): Promise<void> => {
    if (resumeInFlight) return
    resumeInFlight = true
    let terminalReleased = false
    try {
      const checked = await preflightResume(candidate.record.header.id)
      const hostHandoff = runtime.handoffResume
      if (hostHandoff === undefined) {
        await overlay.close()
        resumeOverlay = undefined
        deps.appendNotice('Session is resumable, but this host cannot hand it off in place.', 'warning')
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
      // The host re-execs into the session's own workspace: process cwd, not the
      // restored session header, is what the filesystem and shell tools resolve
      // against.
      await hostHandoff(checked.id, checked.cwd)
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
    showResume(): void {
      if (agent.status !== 'idle') {
        deps.appendNotice('Resume requires the current turn to finish or be cancelled first.', 'warning')
        return
      }
      const listQuery = sessionQuery()
      if (listQuery === undefined) {
        deps.appendNotice('Resume is not available: session query is not mounted.', 'warning')
        return
      }
      const scan = ++resumeScan
      void resumeOverlay?.close()
      void listQuery.listSessions().then(async (records) => {
        if (deps.isDisposed() || scan !== resumeScan) return
        // Every workspace in the store is summarized; the picker owns the
        // current-workspace/all-workspaces scope split over the whole set.
        const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))
        const candidates = await Promise.all(records.map(record => readResumeCandidate(record, providers)))
        candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt
          || a.record.header.id.localeCompare(b.record.header.id))
        if (deps.isDisposed() || scan !== resumeScan) return
        const session = overlayManager.open({
          create: host => new ResumePicker(
            candidates,
            resolved.maxResumeOptions,
            workspaceLabel(agent.session.header.cwd),
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
