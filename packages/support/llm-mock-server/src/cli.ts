/**
 * Dependency-free CLI parsing for the standalone mock LLM server.
 * @module @deepseek-ai/dsh-llm-mock-server/cli
 */

import { MAX_MOCK_LLM_TIMER_DELAY_MS, MOCK_LLM_BEHAVIORS } from './index.ts'
import type {
  ConcreteMockLlmBehavior,
  MockLlmBehavior,
  MockLlmRandomWeights,
  MockLlmServerOptions,
} from './index.ts'

/** Listener lifecycle behavior understood only by the standalone CLI. */
export const CONNECTION_REFUSED_BEHAVIOR = 'connection_refused'

/** Parsed CLI configuration, including a pre-listen unavailable interval. */
export interface MockLlmCliConfig {
  /** Server options after removing the lifecycle-only `connection_refused` entry. */
  readonly server: MockLlmServerOptions
  /** Delay before binding the model port; an integer from zero through the Node timer maximum. */
  readonly listenDelayMs: number
  /** Whether the original sequence requested a true pre-listen refusal phase. */
  readonly startsUnavailable: boolean
}

/** Result of parsing `dsh-llm-mock-server` arguments. */
export type MockLlmCliParseResult =
  | { readonly kind: 'help' }
  | { readonly kind: 'run'; readonly config: MockLlmCliConfig }

const BEHAVIORS = new Set<string>(MOCK_LLM_BEHAVIORS)
const DEFAULT_LISTEN_DELAY_MS = 750

/** Command usage written for `--help` and invalid arguments. */
export const MOCK_LLM_CLI_USAGE = `Usage: dsh-llm-mock-server [options]

Required:
  --sequence <a,b,...>       Ordered behaviors; connection_refused is allowed first

Listener:
  --host <host>              Default 127.0.0.1
  --port <port>              Default 8000; required and nonzero for connection_refused
  --api-key <token>          Validate exact Bearer token when present
  --listen-delay-ms <ms>     Unavailable interval (default 750 with connection_refused)
  --repeat-last              Repeat the final request behavior after exhaustion
  --seed <uint32>            Reproduce random selections
  --random-weights <a=n,...> Relative weights for concrete behaviors

Response:
  --success-text <text>
  --partial-text <text>
  --reasoning-text <text>
  --chunk-size <count>
  --chunk-delay-ms <ms>
  --disconnect-delay-ms <ms>
  --retry-after-ms <ms>
  --request-id <id>
  --tool-name <name>
  --tool-arguments <json>

Other:
  --help
`

function optionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`dsh-llm-mock-server: ${option} requires a value`)
  }
  return value
}

function numberValue(option: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`dsh-llm-mock-server: ${option} must be a finite number`)
  return parsed
}

function boundedIntegerValue(option: string, value: string, min: number, max: number): number {
  const parsed = numberValue(option, value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`dsh-llm-mock-server: ${option} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function parseSequence(raw: string): { startsUnavailable: boolean; sequence: MockLlmBehavior[] } {
  const entries = raw.split(',').map(entry => entry.trim())
  if (entries.some(entry => entry.length === 0)) {
    throw new Error('dsh-llm-mock-server: --sequence must contain non-empty comma-separated behaviors')
  }
  const startsUnavailable = entries[0] === CONNECTION_REFUSED_BEHAVIOR
  if (entries.slice(1).includes(CONNECTION_REFUSED_BEHAVIOR)) {
    throw new Error('dsh-llm-mock-server: connection_refused is allowed only as the first behavior')
  }
  const requestEntries = startsUnavailable ? entries.slice(1) : entries
  if (requestEntries.length === 0) {
    throw new Error('dsh-llm-mock-server: connection_refused must be followed by a request behavior')
  }
  for (const entry of requestEntries) {
    if (!BEHAVIORS.has(entry)) throw new Error(`dsh-llm-mock-server: unknown behavior ${JSON.stringify(entry)}`)
  }
  return { startsUnavailable, sequence: requestEntries as MockLlmBehavior[] }
}

function parseRandomWeights(raw: string): MockLlmRandomWeights {
  const weights: MockLlmRandomWeights = {}
  for (const entry of raw.split(',')) {
    const [behavior, rawWeight, ...extra] = entry.split('=')
    if (behavior === undefined || behavior === '' || rawWeight === undefined || rawWeight === '' || extra.length > 0) {
      throw new Error('dsh-llm-mock-server: --random-weights expects behavior=weight comma-separated entries')
    }
    if (!BEHAVIORS.has(behavior) || behavior === 'random') {
      throw new Error(`dsh-llm-mock-server: random weight requires a concrete behavior, got ${JSON.stringify(behavior)}`)
    }
    if (Object.hasOwn(weights, behavior)) {
      throw new Error(`dsh-llm-mock-server: duplicate random weight for ${JSON.stringify(behavior)}`)
    }
    weights[behavior as ConcreteMockLlmBehavior] = numberValue('--random-weights', rawWeight)
  }
  return weights
}

/**
 * Parse standalone server arguments without starting a process or listener.
 * @param argv - arguments after the executable name.
 * @returns help or validated run configuration.
 */
export function parseMockLlmCliArgs(argv: readonly string[]): MockLlmCliParseResult {
  if (argv.includes('--help')) return { kind: 'help' }

  let sequenceRaw: string | undefined
  let host: string | undefined
  let port = 8_000
  let apiKey: string | undefined
  let listenDelayMs: number | undefined
  let repeatLast = false
  let randomSeed: number | undefined
  let randomWeights: MockLlmRandomWeights | undefined
  let successText: string | undefined
  let partialText: string | undefined
  let reasoningText: string | undefined
  let chunkSize: number | undefined
  let chunkDelayMs: number | undefined
  let disconnectDelayMs: number | undefined
  let retryAfterMs: number | undefined
  let requestId: string | undefined
  let toolName: string | undefined
  let toolArguments: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index] as string
    if (option === '--repeat-last') {
      repeatLast = true
      continue
    }
    const value = optionValue(argv, index, option)
    index += 1
    switch (option) {
      case '--sequence': sequenceRaw = value; break
      case '--host': host = value; break
      case '--port': port = numberValue(option, value); break
      case '--api-key': apiKey = value; break
      case '--listen-delay-ms':
        listenDelayMs = boundedIntegerValue(option, value, 0, MAX_MOCK_LLM_TIMER_DELAY_MS)
        break
      case '--seed': randomSeed = numberValue(option, value); break
      case '--random-weights': randomWeights = parseRandomWeights(value); break
      case '--success-text': successText = value; break
      case '--partial-text': partialText = value; break
      case '--reasoning-text': reasoningText = value; break
      case '--chunk-size': chunkSize = numberValue(option, value); break
      case '--chunk-delay-ms': chunkDelayMs = numberValue(option, value); break
      case '--disconnect-delay-ms': disconnectDelayMs = numberValue(option, value); break
      case '--retry-after-ms': retryAfterMs = numberValue(option, value); break
      case '--request-id': requestId = value; break
      case '--tool-name': toolName = value; break
      case '--tool-arguments': toolArguments = value; break
      default: throw new Error(`dsh-llm-mock-server: unknown option ${JSON.stringify(option)}`)
    }
  }

  if (sequenceRaw === undefined) throw new Error('dsh-llm-mock-server: --sequence is required')
  const parsedSequence = parseSequence(sequenceRaw)
  if (parsedSequence.startsUnavailable && port === 0) {
    throw new Error('dsh-llm-mock-server: connection_refused requires an explicit nonzero --port')
  }
  if (!parsedSequence.startsUnavailable && listenDelayMs !== undefined) {
    throw new Error('dsh-llm-mock-server: --listen-delay-ms requires connection_refused first in --sequence')
  }
  if (!parsedSequence.sequence.includes('random') && (randomSeed !== undefined || randomWeights !== undefined)) {
    throw new Error('dsh-llm-mock-server: --seed and --random-weights require random in --sequence')
  }

  return {
    kind: 'run',
    config: {
      server: {
        sequence: parsedSequence.sequence,
        port,
        repeatLast,
        ...randomSeed === undefined ? {} : { randomSeed },
        ...randomWeights === undefined ? {} : { randomWeights },
        ...host === undefined ? {} : { host },
        ...apiKey === undefined ? {} : { apiKey },
        ...successText === undefined ? {} : { successText },
        ...partialText === undefined ? {} : { partialText },
        ...reasoningText === undefined ? {} : { reasoningText },
        ...chunkSize === undefined ? {} : { chunkSize },
        ...chunkDelayMs === undefined ? {} : { chunkDelayMs },
        ...disconnectDelayMs === undefined ? {} : { disconnectDelayMs },
        ...retryAfterMs === undefined ? {} : { retryAfterMs },
        ...requestId === undefined ? {} : { requestId },
        ...toolName === undefined ? {} : { toolName },
        ...toolArguments === undefined ? {} : { toolArguments },
      },
      listenDelayMs: parsedSequence.startsUnavailable ? listenDelayMs ?? DEFAULT_LISTEN_DELAY_MS : 0,
      startsUnavailable: parsedSequence.startsUnavailable,
    },
  }
}
