/** Test-only Loader plugin that creates a goal at the first real step edge. */

import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-goal'

export const name = 'seed-goal'
export const inject = ['goals']

export function apply(ctx: Context): void {
  ctx.on('agent/step', (agent) => {
    if (ctx.goals.get(agent) !== undefined) return
    ctx.goals.create(agent, {
      objective: 'Prove the composed goal survives in the session log',
      maxGoalRounds: 7,
    })
  })
}
