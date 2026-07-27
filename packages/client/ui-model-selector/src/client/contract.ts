/**
 * Model-selector slot contract: standard session props plus the plain
 * object-layer actions injected by this package's registration.
 */
import type { ModelTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Plain callbacks contributed by the selector registration. */
export interface ModelSelectorInjected {
  /** Refresh the session's advisory model directory. */
  refreshModels(): void
  /**
   * Retry the directory refresh or exact selection that produced the visible operation error.
   * @returns Whether a model selection succeeded and the menu should close.
   */
  retryModelOperation(): Promise<boolean>
  /**
   * Select a complete provider/model target.
   * @param target - Target selected from one provider group.
   * @returns Whether the host accepted the selection.
   */
  selectModel(target: ModelTarget): Promise<boolean>
}

/** Full props of the conversation model-control occupant. */
export type ModelSelectorProps =
  PropsRuntime<'conversation.input.model'> & ModelSelectorInjected
