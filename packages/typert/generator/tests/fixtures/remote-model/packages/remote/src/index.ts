import { Remote, RemoteContext, bindTypeRTGateway } from '@deepseek-ai/dsh-type-meta'
import type { Agent } from '@fixture/domain'
import type {
  CreateGoalRequest,
  CreateGoalResult,
  RenameGoalRequest,
  RenameGoalResult,
} from './types.ts'

/** Remote-only business Service with no Cordis declaration merge. */
export class GoalService {
  readonly typertGateway = bindTypeRTGateway(this, 'goals')

  @Remote
  async create(agent: Agent, request: CreateGoalRequest): Promise<CreateGoalResult> {
    return { ref: `${agent.id}:${request.title}` }
  }

  @RemoteContext('agent')
  rename(request: RenameGoalRequest): RenameGoalResult {
    return { renamed: request.title.length > 0 }
  }
}

export type {
  CreateGoalRequest,
  CreateGoalResult,
  RenameGoalRequest,
  RenameGoalResult,
} from './types.ts'
