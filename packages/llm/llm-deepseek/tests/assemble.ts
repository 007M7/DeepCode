/**
 * Test helper: drive `ctx.llm.stream()` through a `BlockAssembler` and return
 * the assembled message + usage + finish reason. This exercises the same
 * streaming path production uses (the loop), rather than a service-level
 * one-shot convenience method.
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import type { FinishReason, GenerateOptions, Message, TokenUsage } from '@deepseek-ai/dsh-llm'

export interface AssembledResult {
  message: Message
  usage?: TokenUsage
  finish: FinishReason
}

export async function assemble(ctx: Context, options: GenerateOptions): Promise<AssembledResult> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  return {
    message: assembler.message(),
    ...assembler.usage !== undefined ? { usage: assembler.usage } : {},
    finish: assembler.finish,
  }
}
