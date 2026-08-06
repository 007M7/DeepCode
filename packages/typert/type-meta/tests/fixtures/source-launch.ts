import { Context } from 'cordis'
import {
  GatewayService,
  Remote,
  RemoteContext,
  remoteMethods,
} from '@deepseek-ai/dsh-type-meta'

class Goals extends GatewayService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote
  create(value: string): string {
    return value
  }

  @RemoteContext('agent')
  scoped(value: string): string {
    return value
  }
}

const methods = remoteMethods(new Goals(new Context()))
const actual = JSON.stringify(methods)
const expected = JSON.stringify([
  { method: 'create', invocation: { kind: 'direct' } },
  { method: 'scoped', invocation: { kind: 'context', context: 'agent' } },
])
if (actual !== expected) throw new Error(`unexpected Remote declarations: ${actual}`)
process.stdout.write(actual)
