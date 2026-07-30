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

import type { AskUserQuestionAnswer, AskUserQuestionItem } from './types.ts'

export type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionIntent, AskUserQuestionItem,
  AskUserQuestionOption,
} from './types.ts'

/** Request for a human answer. */
export interface AskUserQuestionRequest {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
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
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserInteractionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserInteractionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
    if (this.provider === undefined) {
      throw new UserInteractionError('no user-interaction provider is registered', 'NO_PROVIDER')
    }
    return this.provider.ask(request)
  }
}

export default UserInteractionService
