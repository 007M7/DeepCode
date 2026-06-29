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
  /** Value returned to the model when selected. Defaults to `label`. */
  value?: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
  /** Marks the recommended/default option. */
  recommended?: boolean
}

/** Request for a human answer. */
export interface AskUserQuestionRequest {
  /** The question to display. */
  question: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether free-form answers are accepted. Defaults to `true`. */
  allowCustom?: boolean
  /** Calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}

/** The human's answer. */
export interface AskUserQuestionAnswer {
  /** Model-facing answer text. */
  answer: string
  /** The selected option, when the answer came from `options`. */
  option?: AskUserQuestionOption
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

  /** Register the UI provider. Only one provider may be active in a context. */
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

  /** Ask the active UI provider and wait for the user's answer. */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw new UserInteractionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    if (this.provider === undefined) {
      throw new UserInteractionError('no user-interaction provider is registered', 'NO_PROVIDER')
    }
    return this.provider.ask(request)
  }
}

export default UserInteractionService
