/**
 * Session-resume sub-controller for the interactive chat channel: the
 * `/resume` selector, one batch summary projection that tolerates a corrupt
 * neighbor, the pre-handoff preflight, and the terminal handoff itself.
 * @module @deepseek-ai/dsh-tui/chat/resume
 */

import type { TUI } from '@earendil-works/pi-tui'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  LogicalSessionSource,
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

  /** Summarize one record from a borrowed source, retaining only the record and derived scalars. */
  const summarize = (
    record: SessionRecord,
    source: LogicalSessionSource,
    providers: ReadonlySet<string>,
  ): ResumeCandidate => summarizeResumeCandidate(
    record,
    source,
    agent.session.id,
    agent.session.header.cwd,
    providers,
    workspaceLabel,
  )

  /** The disabled fallback row for a session whose log cannot be summarized. */
  const unreadableCandidate = (record: SessionRecord, error: unknown): ResumeCandidate => ({
    record,
    title: 'Unreadable session',
    lastActivityAt: record.header.createdAt,
    lastTurn: 'log unavailable',
    currentWorkspace: record.header.cwd === agent.session.header.cwd,
    workspaceLabel: workspaceLabel(record.header.cwd),
    disabledReason: `session cannot be loaded: ${errorChain(error)}`,
  })

  /** Build one exact candidate from a live-preferred read that replay-validates a persisted log. */
  const readResumeCandidate = async (
    record: SessionRecord,
    providers: ReadonlySet<string>,
  ): Promise<ResumeCandidate> => {
    try {
      const readQuery = sessionQuery()
      /* v8 ignore start -- caller proves the optional service before mapping records */
      if (readQuery === undefined) throw new Error('session query is unavailable')
      /* v8 ignore stop */
      const snapshot = await readQuery.readSession(record.header.id)
      return summarize(record, { header: snapshot.session, events: snapshot.events }, providers)
    } catch (error: unknown) {
      return unreadableCandidate(record, error)
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
      // The picker opens before the scan settles so the terminal stops feeding
      // the editor immediately; a queued activation (the closing predecessor
      // still holds the slot) receives an already-scanned set through
      // `scanned` instead of a loading placeholder.
      let picker: ResumePicker | undefined
      let scanned: ResumeCandidate[] | undefined
      const session = overlayManager.open({
        create: (host) => {
          picker = new ResumePicker(
            scanned,
            resolved.maxResumeOptions,
            workspaceLabel(agent.session.header.cwd),
            () => host.viewport.rows,
            palette,
            (candidate) => { void handoffResume(candidate, session) },
            () => { void session.close() },
          )
          return picker
        },
        options: {
          width: '100%',
          maxHeight: '100%',
          anchor: 'top-left',
          margin: 0,
        },
      })
      resumeOverlay = session
      // Closing the picker — Escape, supersession, disposal — aborts the scan:
      // the borrowed-log pass over a large store must not outlive its overlay.
      const scanAbort = new AbortController()
      void session.closed.then(() => {
        scanAbort.abort()
        /* v8 ignore next -- overlay FIFO closes this session before a replacement can become the tracked resume overlay */
        if (resumeOverlay === session) resumeOverlay = undefined
      })
      deps.requestRender()
      /** Whether this scan's overlay, session generation, or TUI is gone. */
      const scanStale = (): boolean =>
        deps.isDisposed() || scan !== resumeScan || scanAbort.signal.aborted
      const scanCandidates = async (): Promise<void> => {
        const records = await listQuery.listSessions(scanAbort.signal)
        if (scanStale()) return
        // Every workspace in the store is summarized; the picker owns the
        // current-workspace/all-workspaces scope split over the whole set.
        const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))
        // One bounded batch projection over borrowed logs: unlike a
        // per-candidate readSession, it lists persistence once and skips
        // replay validation and log cloning, bounding memory by what each
        // summary retains. A corrupt neighbor degrades to one disabled row.
        const recordById = new Map(records.map(record => [record.header.id, record]))
        const listedRecord = (id: SessionId): SessionRecord => {
          const record = recordById.get(id)
          /* v8 ignore next 2 -- projection ids come from this map; the corpus verifies each loaded header id */
          if (record === undefined) throw new Error(`resume scan returned unlisted session "${id}"`)
          return record
        }
        const results = await listQuery.projectSessions(
          records.map(record => record.header.id),
          source => summarize(listedRecord(source.header.id), source, providers),
          scanAbort.signal,
        )
        const candidates = results.map(result => result.status === 'fulfilled'
          ? result.value
          : unreadableCandidate(listedRecord(result.sessionId), result.reason))
        candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt
          || a.record.header.id.localeCompare(b.record.header.id))
        if (scanStale()) return
        scanned = candidates
        picker?.setCandidates(candidates)
        deps.requestRender()
      }
      // One catch covers both stages, so a projection failure cannot strand
      // the overlay on its loading placeholder; an aborted scan's rejection
      // stays silent because the user already dismissed the picker.
      void scanCandidates().catch((error: unknown) => {
        if (scanStale()) return
        void session.close()
        deps.appendNotice(`Resume session scan failed: ${errorChain(error)}`, 'error')
      })
    },
  }
}
