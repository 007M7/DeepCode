/** Registers the conversation components, shared store, and service callbacks. */
import type { Context } from 'cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ViewTab } from './contract/views.ts'
import type {
  ApprovalWait, ChatViewInjected, ComposerBarInjected, ComposerChainProps, ConversationInjected,
  ConversationSessionInjected, DetailsInjected,
} from './contract/slots.ts'
import type { InputNotice } from './input/contract.ts'
import { resolveToolPath } from './contract/tool-call-model.ts'
import { createChatStore } from './stores.ts'
import { ConversationService } from './service.ts'
import type { IConversation } from './service.ts'
import { InputHub } from './input/hub.ts'
import { InputBar } from './skeleton/InputBar.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { StatsLine } from './chat/StatsLine.tsx'
import { bashToolviewSample } from './toolviews/bash-sample.tsx'
import { ApprovalPanel } from './skeleton/ApprovalPanel.tsx'
import { todoToolview } from './toolviews/todo-row.tsx'
import { askQuestionToolview } from './toolviews/ask-question-row.tsx'
import { todoDockEntry } from './skeleton/TodoPanel.tsx'
import { queueDockEntry } from './queue/QueueDock.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { ConversationSession } from './skeleton/ConversationSession.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'

/** Services required by the conversation plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale']

// Static no-session sources for the composer-bar hooks compartment: module
// constants so the render side's per-source hook cache (observableHook) keeps
// one identity across every no-session render.
const ABSENT_NOTICES = {
  getSnapshot: (): InputNotice | null => null,
  subscribe: () => () => {},
}
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()
const ABSENT_LEXICON = {
  getSnapshot: () => EMPTY_LEXICON,
  subscribe: () => () => {},
}

/** Resolve the session-scoped conversation face (scope-addressed send/cancel), failing loud. */
function scopedConversation(sessions: ISessions, id: SessionId): IConversation {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`ui-conversation: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable through the session scope')
  return conversation
}

/** Chain routing: claim the composer while an approval wait is pending (pure — owner props only). */
function selectApproval({ interactions }: ComposerChainProps): ApprovalWait | null {
  return interactions.find((i): i is ApprovalWait => i.kind === 'approval') ?? null
}

/** Mounts the conversation plugin.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces
  const layout = ctx.layout
  const slots = ctx.slots

  // Command hint locale: friendly placeholder text for claimed commands. The
  // claimed /plan hint and the plan-mode textarea placeholder share one
  // string: both describe the same next action.
  const HINT_NS = 'command.hint'
  const PLAN_HINT_ZH = '描述你的任务以生成计划'
  const PLAN_HINT_EN = 'describe your task to generate plan'
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(HINT_NS, 'zh', {
        plan: PLAN_HINT_ZH,
        goal: '输入目标，智能体将持续执行',
        'goal.active': '当前目标进行中。可输入 edit 修改 / pause 暂停 / resume 继续 / clear 清除',
        'placeholder.plan': PLAN_HINT_ZH,
        'placeholder.default': '给智能体发消息',
      }),
      ctx.locale.register(HINT_NS, 'en', {
        plan: PLAN_HINT_EN,
        goal: 'describe the objective for a long-running task',
        'goal.active': 'goal active — edit / pause / resume / clear',
        'placeholder.plan': PLAN_HINT_EN,
        'placeholder.default': 'Message the agent',
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-conversation: command hint dictionaries')
  const translateHint = ctx.locale.bind(HINT_NS)

  // Apply-time construction keeps store identity bound to this fiber.
  const chatStore = createChatStore()

  const viewTabs = (): ViewTab[] => {
    const tabs: ViewTab[] = []
    for (const entry of slots.entries('conversation.view')) {
      /* v8 ignore next -- unreachable: list registration validates id at load. */
      if (entry.options.id === undefined) continue
      tabs.push({ id: entry.options.id, label: entry.options.label ?? entry.options.id })
    }
    return tabs
  }

  // The per-session input machine registry (InputService face; published as
  // ctx.conversation.input by the service below sharing this one instance).
  const inputHub = new InputHub(ctx)

  // Decision 19/20: the input machine feeds every session-scope slot
  // component through the standard provide channel — the 'input' hook plus
  // the two public actions. Materialization is the shell creation trigger
  // (per-session lazy; scope disposer tears down).
  ctx.effect(() => sessions.provide({
    hooks: ['input'],
    props: ['inputActions'],
    resolve: (binding) => {
      const shell = inputHub.shellFor(binding)
      return {
        hooks: { input: shell.state },
        props: { inputActions: shell.actions },
      }
    },
  }), 'ui-conversation: input standard-kit provider')

  // Resident current-session-optional shell. It owns the stable Hero/composer
  // frame while strict session slots fill only their session-bound regions.
  slots.register({
    name: 'conversation',
    children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
    },
    inject: (sessionId: SessionId | undefined): ConversationInjected => ({
      selectWorkspace: async (workspaceId) => {
        const nextId = await workspaces.connectWorkspace(workspaceId)
        if (sessionId !== undefined && nextId !== sessionId) {
          const from = inputHub.shell(sessionId)
          const draft = from.snapshot.draft
          if (draft !== '') {
            inputHub.shell(nextId).setDraft(draft)
            from.setDraft('')
          }
        }
        sessions.open(nextId)
      },
    }),
  }, ConversationRoot)

  // The strict session subtree owns only per-session store and view content;
  // the resident parent keeps Hero and composer layout identity stable.
  slots.register({
    name: 'conversation.session',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    store: chatStore,
    inject: (sessionId: SessionId, _actions: BoundActions<typeof chatStore>): ConversationSessionInjected => ({
      views: {
        list: viewTabs,
        subscribe: fn => slots.subscribe('conversation.view', fn),
        version: () => slots.getVersion('conversation.view'),
      },
      bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
      open: (id) => { sessions.open(id) },
    }),
  }, ConversationSession)

  // The default composer body: its own single slot inside the composer
  // chain's fallback (decision 20). Public machine surface arrives via the
  // provide channel above; the keyboard command face and the stop/retry
  // verbs ride this inject (package-internal — hub and bar are one plugin).
  // Session-maybe: with no current session the machine faces are absent and
  // the hooks compartment binds static empty sources (module constants, so
  // observableHook caching and hook order stay stable across transitions).
  slots.register({
    name: 'conversation.composer.bar',
    // The two named control seats in the bar's tool row (plan beside the
    // access control, model right); empty until their owning plugins
    // register (B ruling).
    children: {
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
    },
    inject: (sessionId: SessionId | undefined): ComposerBarInjected => {
      if (sessionId === undefined) {
        return {
          keyboard: undefined,
          stop: undefined,
          command: undefined,
          translateHint,
          hooks: { notices: ABSENT_NOTICES, lexicon: ABSENT_LEXICON },
        }
      }
      const shell = inputHub.shell(sessionId)
      return {
        keyboard: shell,
        stop: () => {
          scopedConversation(sessions, sessionId).cancel().catch(() => {
            // Stop failure surfaces via snapshot.promptError; nothing to restore.
          })
        },
        command: async (line) => {
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) return false
          const result = await session.command(line)
          return result.ok && result.value.matched
        },
        translateHint,
        hooks: { notices: shell.notices, lexicon: shell.lexicon },
      }
    },
  }, InputBar)

  // The approval takeover: a selector-routed entry of the chain this package
  // just declared (the ui-question registration pattern; the entry lives here
  // because approval answering is core conversation UX, not an optional tool).
  // Zero business face — data and verbs both ride the matched carrier.
  // priority 1: question takeovers (default 0) win when both kinds are
  // pending — a question is a conversation the model is waiting on, while an
  // approval only blocks one tool call; answering the question first cannot
  // strand the approval (it re-elects the moment the question resolves).
  slots.register({ name: 'conversation.composer', select: selectApproval, priority: 1 }, ApprovalPanel)

  // The chat view: first entry of the ring this package just declared.
  // Declaring the keyed toolview hole here is claiming it: ChatView is the
  // only component authorized to render per-tool rows. Shares the chat
  // store, so its selection writes land in the same per-session instance the
  // details panel reads.
  slots.register({
    name: 'conversation.view',
    id: 'chat',
    order: 0,
    label: 'Chat',
    children: {
      'conversation.chat.toolview': { kind: 'keyed', scope: 'session' },
      'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    },
    store: chatStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ChatViewInjected => {
      const scoped = scopedConversation(sessions, sessionId)
      return {
        openDetails: (target) => {
          actions.select(target)
          layout.openDetails()
        },
        openFile: (path) => {
          const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
          void workspaces.openPath(resolveToolPath(cwd, path)).catch(() => {
            // Host/OS open failures stay silent in the chat row; the native
            // app surfaces its own error dialog when the path is unusable.
          })
        },
        loadOlder: () => { void scoped.loadOlder() },
      }
    },
  }, ChatView)

  // Session stats stick with the composer (composer.dock = stats-line family).
  slots.register({ name: 'conversation.composer.dock', id: 'stats', order: 0 }, StatsLine)

  // Class-plugin mount (packages/AGENTS.md service form): the service
  // registers itself as `conversation` and lives on its own child fiber.
  // Mounted AFTER the chat entry register above — construction guarantee for
  // toolview registrants using `inject: ['conversation']` as their load-order
  // seam: the service being present implies the chat entry (and with it the
  // 'conversation.chat.toolview' declaration) is on the ledger.
  ctx.plugin(ConversationService, { input: inputHub })

  // The bash sample rides that exact seam, in third-party posture
  // (ToolRow-matching Bash · {description} chrome; scoped badge in child sessions).
  ctx.plugin(bashToolviewSample)

  // The todo_write row rides the same seam (a product registration, not a sample).
  ctx.plugin(todoToolview)

  // The ask_user_question row: waiting/answered/cancelled interaction outcome.
  ctx.plugin(askQuestionToolview)

  // The plan strip rides the input dock above the queue rows (same posture).
  ctx.plugin(todoDockEntry)

  // The read-only queue dock entry (T9 file territory) rides the same
  // registration seam into the input dock declared above.
  ctx.plugin(queueDockEntry)

  slots.register({
    name: 'details',
    store: chatStore,
    inject: (): DetailsInjected => ({
      closeDetails: () => { layout.closeDetails() },
    }),
  }, DetailsPanel)

}
