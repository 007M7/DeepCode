#!/usr/bin/env node
/**
 * Self-executing dsh launcher.
 *
 * @module @deepseek-ai/dsh-scripts/bin
 */

import { runDshCommand } from './command.ts'

process.exitCode = await runDshCommand()
