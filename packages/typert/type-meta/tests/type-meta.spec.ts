import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bindTypeRTGateway,
  Remote,
  RemoteContext,
  remoteMethods,
  type TypeRTContext,
} from '@deepseek-ai/dsh-type-meta'

declare module '@deepseek-ai/dsh-type-meta' {
  interface TypeRTContextMap {
    metaFixture: TypeRTContext<string>
  }
}

describe('type-meta Remote declarations', () => {
  it('executes standard decorator syntax through the Vitest source transform', () => {
    class Goals {
      readonly typertGateway = bindTypeRTGateway(this, 'goals')

      @Remote
      create(value: string): string {
        return value
      }

      @RemoteContext('metaFixture')
      scoped(value: string): string {
        return value
      }
    }

    const goals = new Goals()
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' } },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' } },
    ])
  })

  it('executes standard decorator syntax through the TSX source launcher', () => {
    const fixture = fileURLToPath(new URL('./fixtures/source-launch.ts', import.meta.url))
    const output = execFileSync(process.execPath, ['--import', 'tsx/esm', fixture], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { method: 'create', invocation: { kind: 'direct' } },
      { method: 'scoped', invocation: { kind: 'context', context: 'agent' } },
    ])
  })

  it('keeps decorator markers in private module state', () => {
    class Goals {
      readonly typertGateway = bindTypeRTGateway(this, 'goals')

      create(agent: object, request: object): object {
        return { agent, request }
      }

      scoped(request: object): object {
        return request
      }
    }

    const initializers: Array<(this: Goals) => void> = []
    Remote(
      Reflect.get(Goals.prototype, 'create') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('create', initializers),
    )
    RemoteContext('metaFixture')(
      Reflect.get(Goals.prototype, 'scoped') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('scoped', initializers),
    )

    const goals = new Goals()
    for (const initialize of initializers) initialize.call(goals)
    expect(goals.typertGateway).toEqual({ service: goals, serviceKey: 'goals', namespace: 'goals' })
    expect(Object.isFrozen(goals.typertGateway)).toBe(true)
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' } },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' } },
    ])
    expect(Reflect.ownKeys(Goals)).toEqual(['length', 'name', 'prototype'])
    expect(Reflect.ownKeys(Goals.prototype)).toEqual(['constructor', 'create', 'scoped'])
  })

  it('keeps markers idempotent across instances and returns detached snapshots', () => {
    class Service {
      run(value: string): string {
        return value
      }
    }

    const initializers: Array<(this: Service) => void> = []
    Remote(
      Reflect.get(Service.prototype, 'run') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('run', initializers),
    )

    const first = new Service()
    const second = new Service()
    for (const initialize of initializers) {
      initialize.call(first)
      initialize.call(second)
    }
    const snapshot = remoteMethods(first)
    expect(remoteMethods(second)).toEqual(snapshot)
    ;(snapshot as unknown as { method: string }[])[0]!.method = 'changed'
    expect(remoteMethods(first)).toEqual([{ method: 'run', invocation: { kind: 'direct' } }])
  })

  it('rejects ambiguous binding names', () => {
    expect(() => bindTypeRTGateway({}, '')).toThrow('service key')
    expect(() => bindTypeRTGateway({}, 'goals', { namespace: 'api/goals' })).toThrow('namespace')
  })
})

function methodContext<This extends object>(
  name: string,
  initializers: Array<(this: This) => void>,
): ClassMethodDecoratorContext<This, (this: This, ...args: unknown[]) => unknown> {
  return {
    kind: 'method',
    name,
    static: false,
    private: false,
    metadata: {},
    access: {
      has: object => name in object,
      get: object => (object as Record<string, unknown>)[name] as (this: This, ...args: unknown[]) => unknown,
    },
    addInitializer: (initializer) => { initializers.push(initializer) },
  }
}
