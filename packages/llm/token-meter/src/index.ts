/**
 * Replay token-meter service with model-specific context capacity and pricing.
 *
 * @module @deepseek-ai/dsh-token-meter
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { HarnessError, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { ReplayModelTokenMeter } from './replay.ts'
import type { ModelTokenProfile } from './replay.ts'
import type {
  ModelTokenMeter,
  ModelTokenMeterConfig,
  TokenMeterConfig,
} from './types.ts'

export type * from './types.ts'

/** Exact error code for resolving a model without a configured profile. */
export const TOKEN_METER_MODEL_UNCONFIGURED = 'TOKEN_METER_MODEL_UNCONFIGURED'

/** Exact error code for invalid token-meter configuration. */
export const TOKEN_METER_INVALID_CONFIG = 'TOKEN_METER_INVALID_CONFIG'

/** Closed machine-routable token-meter failure taxonomy. */
export type TokenMeterErrorCode =
  | typeof TOKEN_METER_MODEL_UNCONFIGURED
  | typeof TOKEN_METER_INVALID_CONFIG

/** Built-in DeepSeek model profiles available with zero configuration. */
const BUILTIN_TOKEN_PROFILES: Readonly<Record<string, Readonly<ModelTokenProfile>>> = deepFreeze({
  'deepseek-v4-flash': {
    model: 'deepseek-v4-flash',
    contextWindow: 128_000,
    charsPerToken: 4,
  },
  'deepseek-v4-pro': {
    model: 'deepseek-v4-pro',
    contextWindow: 128_000,
    charsPerToken: 4,
  },
})

/** Typed token-meter failure with the affected model preserved for callers. */
export class TokenMeterError extends HarnessError {
  declare readonly code: TokenMeterErrorCode
  /** Exact model name involved in this error, when applicable. */
  readonly model: string | undefined

  constructor(message: string, code: TokenMeterErrorCode, model?: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'TokenMeterError'
    this.model = model
  }
}

declare module 'cordis' {
  interface Context {
    tokenMeter: TokenMeterService
  }
}

/** Validate and detach all configured model profiles. */
function resolveProfiles(config: TokenMeterConfig): readonly ModelTokenProfile[] {
  const profiles = new Map<string, ModelTokenProfile>()
  for (const profile of Object.values(BUILTIN_TOKEN_PROFILES)) {
    profiles.set(profile.model, { ...profile })
  }

  const configuredValue: unknown = config.models
  const configuredModels = configuredValue === undefined ? {} : configuredValue
  if (typeof configuredModels !== 'object'
    || configuredModels === null
    || Array.isArray(configuredModels)) {
    throw new TokenMeterError(
      'TokenMeterConfig: models must be an object',
      TOKEN_METER_INVALID_CONFIG,
    )
  }

  for (const [model, override] of Object.entries(configuredModels as Record<string, unknown>)) {
    if (model.length === 0) {
      throw new TokenMeterError(
        'TokenMeterConfig: model names must not be empty',
        TOKEN_METER_INVALID_CONFIG,
        model,
      )
    }
    assertProfileObject(model, override)
    const builtIn = profiles.get(model)
    const contextWindow = override.contextWindow ?? builtIn?.contextWindow
    const charsPerToken = override.charsPerToken ?? builtIn?.charsPerToken ?? 4
    if (contextWindow === undefined) {
      throw new TokenMeterError(
        `TokenMeterConfig: custom model "${model}" requires contextWindow`,
        TOKEN_METER_INVALID_CONFIG,
        model,
      )
    }
    assertPositiveInteger(model, 'contextWindow', contextWindow)
    assertPositiveFinite(model, 'charsPerToken', charsPerToken)
    profiles.set(model, { model, contextWindow, charsPerToken })
  }

  for (const profile of profiles.values()) {
    assertPositiveInteger(profile.model, 'contextWindow', profile.contextWindow)
    assertPositiveFinite(profile.model, 'charsPerToken', profile.charsPerToken)
  }
  return deepFreeze([...profiles.values()].map(profile => ({ ...profile })))
}

function assertProfileObject(model: string, value: unknown): asserts value is ModelTokenMeterConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TokenMeterError(
      `TokenMeterConfig: profile "${model}" must be an object`,
      TOKEN_METER_INVALID_CONFIG,
      model,
    )
  }
}

function assertPositiveInteger(model: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TokenMeterError(
      `TokenMeterConfig: ${model}.${name} (${value}) must be a positive integer`,
      TOKEN_METER_INVALID_CONFIG,
      model,
    )
  }
}

function assertPositiveFinite(model: string, name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TokenMeterError(
      `TokenMeterConfig: ${model}.${name} (${value}) must be a positive finite number`,
      TOKEN_METER_INVALID_CONFIG,
      model,
    )
  }
}

/** Concrete registry and replay owner for all configured model meters. */
export class TokenMeterService extends Service {
  static Config: z<TokenMeterConfig> = z.object({
    models: z.dict(z.object({
      contextWindow: z.number(),
      charsPerToken: z.number(),
    })),
  })

  private readonly meters = new Map<string, ReplayModelTokenMeter>()

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    for (const profile of resolveProfiles(config)) {
      this.meters.set(profile.model, new ReplayModelTokenMeter(profile))
    }

    // Readers catch up independently, while eager observation bounds ordinary
    // read latency. A reader in an earlier listener consumes the new event;
    // this listener then sees the same revision and performs no duplicate fold.
    ctx.on('session/event', (session) => {
      this._observe(session)
    })
  }

  /**
   * Resolve one stable model-bound replay handle.
   * @param model - exact routed model name.
   * @throws {@link TokenMeterError} with `TOKEN_METER_MODEL_UNCONFIGURED` when no profile exists.
   * @returns the configured handle for this model.
   */
  resolve(model: string): ModelTokenMeter {
    const meter = this.meters.get(model)
    if (meter === undefined) {
      throw new TokenMeterError(
        `token meter has no profile for model "${model}"`,
        TOKEN_METER_MODEL_UNCONFIGURED,
        model,
      )
    }
    return meter
  }

  /** Advance every configured model's isolated replay fold. */
  private _observe(session: Session): void {
    for (const meter of this.meters.values()) meter.observeIfActive(session)
  }
}

export default TokenMeterService
