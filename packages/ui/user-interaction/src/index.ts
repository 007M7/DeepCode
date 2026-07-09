/**
 * User-interaction seam (`ctx.userInteraction`): a UI-backed service for
 * pausing an agent tool call until the human answers a question. The model-
 * facing tool lives in `@deepseek-ai/dsh-tool-ask-user`; UI packages provide
 * the single active provider.
 *
 * @module @deepseek-ai/dsh-user-interaction
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'

declare module 'cordis' {
  interface Context {
    userInteraction: UserInteractionService
  }
}

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}

/** One question in an ask_user_question request. */
export interface AskUserQuestionItem {
  /** Stable model-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
}

/** Request for a human answer. */
export interface AskUserQuestionRequest {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}

/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. Empty when the answer is purely custom text. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The human's answer. */
export interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}

/** UI-side provider for user questions. */
export interface UserInteractionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/** Stable error taxonomy for user-interaction failures. */
export class UserInteractionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserInteractionError'
  }
}

/** `ctx.userInteraction`: one active UI provider plus an `ask()` surface. */
export class UserInteractionService extends Service {
  private provider: UserInteractionProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'userInteraction')
  }

  /**
   * Register the UI provider. Only one provider may be active in a context.
   *
   * @param provider UI-side implementation that collects answers.
   * @returns Disposer that unregisters this provider.
   */
  registerProvider(provider: UserInteractionProvider): () => void {
    const dispose = this.ctx.effect(function* (this: UserInteractionService) {
      if (this.provider !== undefined) {
        throw new UserInteractionError('a user-interaction provider is already registered', 'DUPLICATE_PROVIDER')
      }
      this.provider = provider
      yield () => {
        this.provider = undefined
      }
    }.bind(this), 'userInteraction.registerProvider()')
    return () => void dispose()
  }

  /**
   * Ask the active UI provider and wait for the user's answer.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw new UserInteractionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    if (request.questions.length === 0) {
      throw new UserInteractionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    if (this.provider === undefined) {
      throw new UserInteractionError('no user-interaction provider is registered', 'NO_PROVIDER')
    }
    return this.provider.ask(request)
  }
}

export default UserInteractionService
