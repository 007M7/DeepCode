import { useMemo, useState, type KeyboardEvent } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkflowRunKey } from './locales.ts'
import type {
  WorkflowRunMemberData, WorkflowRunPhaseData, WorkflowRunStatus,
} from './workflow-definition.ts'
import css from './WorkflowRunPanel.module.css'

/** Navigation action injected from the plugin's own SessionsService access. */
export interface WorkflowRunInjected {
  readonly openSession: (id: SessionId) => void
}

/** Complete keyed Chat renderer props. */
export type WorkflowRunPanelProps =
  PropsRuntime<'conversation.chat.node', 'workflow-run'>
  & PropsLocale<'workflowRun'>
  & WorkflowRunInjected

const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  interrupted: 'status.interrupted',
} as const satisfies Record<WorkflowRunStatus, WorkflowRunKey>

function dotState(status: WorkflowRunStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled':
    case 'interrupted': return 'warning'
    /* v8 ignore next -- WorkflowRunStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

function readablePhase(phase: string | null, t: WorkflowRunPanelProps['t']): string {
  if (phase === null) return t('phase.unassigned')
  return phase === '' ? t('phase.empty') : phase
}

function readableMember(label: string, t: WorkflowRunPanelProps['t']): string {
  return label === '' ? t('member.empty') : label
}

function statusCount(
  status: WorkflowRunStatus,
  count: number,
  t: WorkflowRunPanelProps['t'],
): string {
  return t(`statusCount.${status}`, { count })
}

function phaseStatusSummary(members: readonly WorkflowRunMemberData[], t: WorkflowRunPanelProps['t']): string {
  const counts = new Map<WorkflowRunStatus, number>()
  for (const member of members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1)
  const count = (status: WorkflowRunStatus): number => counts.get(status) ?? 0
  const active = (['running', 'failed', 'cancelled', 'interrupted'] as const)
    .filter(status => count(status) > 0)
  if (active.length === 0) return statusCount('completed', count('completed'), t)
  const visible = active.includes('interrupted') && count('completed') > 0
    ? ['completed' as const, ...active]
    : active
  return visible.map(status => statusCount(status, count(status), t)).join(' · ')
}

function handleDisclosureKey(event: KeyboardEvent<HTMLDivElement>, onToggle: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  onToggle()
}

function RunHeader({ count, name, onToggle, open, status, t }: {
  readonly count: number
  readonly name: string
  readonly onToggle: () => void
  readonly open: boolean
  readonly status: WorkflowRunStatus
  readonly t: WorkflowRunPanelProps['t']
}) {
  return (
    <div
      className={css.runHeader}
      data-run-header
      data-status={status}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(event) => { handleDisclosureKey(event, onToggle) }}
    >
      <span className={css.runLeading}>
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
      </span>
      <span className={css.runTitle}>{t('run.title', { name })}</span>
      <span className={css.separator} aria-hidden />
      <span className={css.runSummary}>{t('run.members', { count })}</span>
      <span className={css.statusTail} data-run-status-tail data-status={status}>
        <StateDot state={dotState(status)} />
        <span>{t(STATUS_KEYS[status])}</span>
      </span>
    </div>
  )
}

function MemberRow({ member, navigable, openSession, t }: {
  readonly member: WorkflowRunMemberData
  readonly navigable: boolean
  readonly openSession: WorkflowRunInjected['openSession']
  readonly t: WorkflowRunPanelProps['t']
}) {
  const name = readableMember(member.label, t)
  const content = (
    <>
      <span className={css.dotSlot}><StateDot state={dotState(member.status)} /></span>
      <span className={css.memberLabelWrap} data-member-label-wrap><span className={css.memberLabel} data-member-label>{name}</span></span>
      <span className={css.memberStatus} data-member-status-text>{t(STATUS_KEYS[member.status])}</span>
    </>
  )
  if (!navigable) {
    return <div className={css.memberRow} data-member-status={member.status}>{content}</div>
  }
  return (
    <button
      type="button"
      className={css.memberButton}
      data-member-status={member.status}
      aria-label={t('member.open', { name })}
      onClick={() => { openSession(member.childId) }}
    >
      {content}
    </button>
  )
}

function PhaseSection({ phase, navigable, openSession, t }: {
  readonly phase: WorkflowRunPhaseData
  readonly navigable: ReadonlySet<SessionId>
  readonly openSession: WorkflowRunInjected['openSession']
  readonly t: WorkflowRunPanelProps['t']
}) {
  const [open, setOpen] = useState(false)
  const toggle = (): void => { setOpen(value => !value) }
  return (
    <div className={css.phase} data-phase-key={phase.key} data-phase-status={phase.status}>
      <div
        className={css.phaseHeader}
        data-phase-header
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => { handleDisclosureKey(event, toggle) }}
      >
        <span className={css.phaseLeading}>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
        <span className={css.phaseTitle}>{readablePhase(phase.phase, t)}</span>
        <span className={css.separator} aria-hidden />
        <span className={css.phaseCount} data-phase-count>{t('run.members', { count: phase.members.length })}</span>
        <span className={css.phaseStatus} data-phase-status-text>{phaseStatusSummary(phase.members, t)}</span>
      </div>
      {open && (
        <div className={css.members}>
          {phase.members.map(member => (
            <MemberRow
              key={member.seq}
              member={member}
              navigable={navigable.has(member.childId)}
              openSession={openSession}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Render one durable workflow run with independent run and phase disclosure. */
export function WorkflowRunPanel({ node, sessionId, useSessions, openSession, t }: WorkflowRunPanelProps) {
  const [open, setOpen] = useState(() => node.data.status === 'running')
  const sessions = useSessions(value => value)
  const navigable = useMemo(() => {
    const ordinary = new Set(sessions.ids)
    const result = new Set<SessionId>()
    for (const phase of node.data.phases) {
      for (const member of phase.members) {
        const summary = sessions.byId[member.childId]
        if (member.status === 'running'
          && ordinary.has(member.childId)
          && summary?.origin === 'subagent'
          && summary.parentId === sessionId
          && summary.running) {
          result.add(member.childId)
        }
      }
    }
    return result
  }, [node.data.phases, sessionId, sessions])
  return (
    <section className={css.root} data-workflow-run data-run-status={node.data.status}>
      <RunHeader
        count={node.data.memberCount}
        name={node.data.name}
        open={open}
        status={node.data.status}
        t={t}
        onToggle={() => { setOpen(value => !value) }}
      />
      {open && (
        <div className={css.phaseList}>
          {node.data.phases.length === 0
            ? <span className={css.empty}>{t('run.empty')}</span>
            : node.data.phases.map(phase => (
              <PhaseSection
                key={phase.key}
                phase={phase}
                navigable={navigable}
                openSession={openSession}
                t={t}
              />
            ))}
        </div>
      )}
    </section>
  )
}
