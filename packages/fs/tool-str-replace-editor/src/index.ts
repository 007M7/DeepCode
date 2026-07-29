/**
 * Model-facing `str_replace_editor` over the Harness filesystem seam.
 * @module @deepseek-ai/dsh-tool-str-replace-editor
 */

import { isAbsolute } from 'node:path'
import type { Context } from 'cordis'
import z from 'schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'

const DEFAULT_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim()

function maybeTruncate(content: string, maxOutputChars: number): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE
}

function expandTabs(content: string, tabSize = 8): string {
  let column = 0
  let result = ''
  for (const character of content) {
    if (character === '\t') {
      const spaces = tabSize - (column % tabSize)
      result += ' '.repeat(spaces)
      column += spaces
      continue
    }
    result += character
    if (character === '\n' || character === '\r') column = 0
    else column += 1
  }
  return result
}

async function resolveTarget(
  ctx: Context,
  path: string,
  requireAbsolutePath: boolean,
  exec: ToolRunContext,
): Promise<FsTarget> {
  if (path.trim().length === 0) throw new Error('path must be a non-empty string')
  if (requireAbsolutePath && !isAbsolute(path)) {
    throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`)
  }
  const cwd = exec.agent?.session.header.cwd
  return ctx.fs.resolve(path, cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal })
}

async function statExisting(
  ctx: Context,
  target: FsTarget,
  command: 'view' | 'str_replace' | 'insert',
  exec: ToolRunContext,
): Promise<FsInfo> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    throw new FsError(
      `The path ${target.displayPath} does not exist. Please provide a valid path.`,
      'FS_NOT_FOUND',
    )
  }
  if (info.type === 'directory' && command !== 'view') {
    throw new FsError(
      `The path ${target.displayPath} is a directory and only the \`view\` command can be used on directories`,
      'FS_NOT_REGULAR_FILE',
    )
  }
  return info
}

function requiredForCommand(
  value: string | undefined,
  parameter: string,
  command: string,
  allowEmpty = true,
): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`)
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`)
  }
  return value
}

function formatFileView(
  path: string,
  content: string,
  maxOutputChars: number,
  viewRange?: number[],
): string {
  const allLines = content.split('\n')
  let lines = allLines
  let initialLine = 1
  let finalLine: number | undefined
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`
  if (viewRange !== undefined) {
    const [requestedInitialLine, requestedFinalLine] = viewRange
    if (
      viewRange.length !== 2
      || requestedInitialLine === undefined
      || requestedFinalLine === undefined
      || !viewRange.every(Number.isInteger)
    ) {
      throw new Error('Invalid `view_range`. It should be a list of two integers.')
    }
    initialLine = requestedInitialLine
    finalLine = requestedFinalLine
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      )
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      )
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
      )
    }
    lines = finalLine === -1
      ? allLines.slice(initialLine - 1)
      : allLines.slice(initialLine - 1, finalLine)
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`
  }
  const numbered = expandTabs(lines
    .map((line, index) => `${String(initialLine + index).padStart(6, ' ')}\t${line}`)
    .join('\n'))
  return maybeTruncate(`${prompt}:\n${numbered}\n`, maxOutputChars)
}

async function listDirectory(
  ctx: Context,
  target: FsTarget,
  maxOutputChars: number,
  exec: ToolRunContext,
): Promise<string> {
  async function visit(dir: FsTarget, depth: number): Promise<string[]> {
    const entries = await ctx.fs.listDir(dir, exec.signal)
    const rows: string[] = []
    for (const entry of entries.filter(candidate =>
      !candidate.name.startsWith('.')
      && !candidate.name.startsWith('node_modules')
      && !candidate.name.startsWith('__pycache__'))) {
      const type = entry.type === 'directory' ? 'd' : entry.type === 'file' ? 'f' : '?'
      rows.push(`${type}\t${entry.target.displayPath}`)
      if (entry.type === 'directory' && depth < 2) {
        rows.push(...await visit(entry.target, depth + 1))
      }
    }
    return rows
  }
  const rows = [`d\t${target.displayPath}`, ...await visit(target, 1)]
  rows.sort((left, right) => {
    const leftPath = left.slice(left.indexOf('\t') + 1)
    const rightPath = right.slice(right.indexOf('\t') + 1)
    return leftPath.localeCompare(rightPath)
  })
  const listing = maybeTruncate(rows.join('\n') + '\n', maxOutputChars)
  return `Here're the files and directories up to 2 levels deep in ${target.displayPath}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`
}

async function viewPath(
  ctx: Context,
  path: string,
  viewRange: number[] | undefined,
  maxOutputChars: number,
  requireAbsolutePath: boolean,
  exec: ToolRunContext,
): Promise<string> {
  const target = await resolveTarget(ctx, path, requireAbsolutePath, exec)
  const info = await statExisting(ctx, target, 'view', exec)
  if (info.type === 'directory') {
    if (viewRange !== undefined) {
      throw new Error('The `view_range` parameter is not allowed when `path` points to a directory.')
    }
    return listDirectory(ctx, target, maxOutputChars, exec)
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot view "${target.displayPath}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
  }
  const content = await ctx.fs.readText(target, exec.signal)
  ctx.emit('fs/observed', target, info.version, exec)
  return formatFileView(target.displayPath, content, maxOutputChars, viewRange)
}

async function createFile(
  ctx: Context,
  path: string,
  fileText: string | undefined,
  requireAbsolutePath: boolean,
  exec: ToolRunContext,
): Promise<string> {
  const content = requiredForCommand(fileText, 'file_text', 'create')
  const target = await resolveTarget(ctx, path, requireAbsolutePath, exec)
  if (await ctx.fs.stat(target, exec.signal) !== undefined) {
    throw new Error(`File already exists at: ${target.displayPath}. Cannot overwrite files using command \`create\`.`)
  }
  const outcome = await ctx.fs.writeText(target, content, { kind: 'createIfAbsent' }, exec.signal)
  ctx.emit('fs/observed', target, outcome.version, exec)
  return `New file created successfully at: ${target.displayPath}`
}

async function replaceInFile(
  ctx: Context,
  path: string,
  oldStr: string | undefined,
  newStr: string | undefined,
  requireAbsolutePath: boolean,
  exec: ToolRunContext,
): Promise<string> {
  const target = await resolveTarget(ctx, path, requireAbsolutePath, exec)
  const oldValue = expandTabs(requiredForCommand(oldStr, 'old_str', 'str_replace', false))
  const newValue = expandTabs(newStr ?? '')
  const info = await statExisting(ctx, target, 'str_replace', exec)
  if (info.type !== 'file') {
    throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  const before = expandTabs(await ctx.fs.readText(target, exec.signal))
  const occurrences = before.split(oldValue).length - 1
  if (occurrences === 0) {
    throw new FsError(
      `No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${target.displayPath}.`,
      'FS_EDIT_NOT_FOUND',
    )
  }
  if (occurrences > 1) {
    const lines = before.split('\n')
      .flatMap((line, index) => line.includes(oldValue) ? [index + 1] : [])
    throw new FsError(
      `No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(', ')}]. Please ensure it is unique`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  const outcome = await ctx.fs.writeText(
    target,
    before.replace(oldValue, newValue),
    { kind: 'replaceIfVersion', version: info.version },
    exec.signal,
  )
  ctx.emit('fs/observed', target, outcome.version, exec)
  return `The file ${target.displayPath} has been edited successfully.`
}

async function insertInFile(
  ctx: Context,
  path: string,
  insertLine: number | undefined,
  newStr: string | undefined,
  requireAbsolutePath: boolean,
  exec: ToolRunContext,
): Promise<string> {
  if (insertLine === undefined) throw new Error('Parameter `insert_line` is required for command: insert')
  const value = expandTabs(requiredForCommand(newStr, 'new_str', 'insert'))
  const target = await resolveTarget(ctx, path, requireAbsolutePath, exec)
  const info = await statExisting(ctx, target, 'insert', exec)
  if (info.type !== 'file') {
    throw new FsError(`cannot insert into "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  const before = expandTabs(await ctx.fs.readText(target, exec.signal))
  const lines = before.split('\n')
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    )
  }
  const after = [
    ...lines.slice(0, insertLine),
    ...value.split('\n'),
    ...lines.slice(insertLine),
  ].join('\n')
  const outcome = await ctx.fs.writeText(
    target,
    after,
    { kind: 'replaceIfVersion', version: info.version },
    exec.signal,
  )
  ctx.emit('fs/observed', target, outcome.version, exec)
  return `The file ${target.displayPath} has been edited successfully.`
}

interface ResolvedConfig {
  maxOutputChars: number
  description: string
  requireAbsolutePath: boolean
}

/** Register the model-facing `str_replace_editor` tool. */
function registerStrReplaceEditor(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'str_replace_editor',
    description: config.description,
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: ['view', 'create', 'str_replace', 'insert'],
        description: 'The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.',
      },
      file_text: {
        type: 'string',
        description: 'Required parameter of `create` command, with the content of the file to be created.',
      },
      insert_line: {
        type: 'integer',
        description: 'Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.',
      },
      new_str: {
        type: 'string',
        description: 'Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.',
      },
      old_str: {
        type: 'string',
        description: 'Required parameter of `str_replace` command containing the string in `path` to replace.',
      },
      view_range: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      switch (args.command) {
        case 'view':
          return viewPath(ctx, args.path, args.view_range, config.maxOutputChars, config.requireAbsolutePath, exec)
        case 'create':
          return createFile(ctx, args.path, args.file_text, config.requireAbsolutePath, exec)
        case 'str_replace':
          return replaceInFile(ctx, args.path, args.old_str, args.new_str, config.requireAbsolutePath, exec)
        case 'insert':
          return insertInFile(ctx, args.path, args.insert_line, args.new_str, config.requireAbsolutePath, exec)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `${args.command} ${args.path}`,
      kind: args.command === 'view' ? 'read' : 'edit',
    }),
  }))
}

export const name = 'tool-str-replace-editor'
export const inject = ['tools', 'fs']

/** Configuration for the string-replacement editor tool. */
export interface Config {
  /** Maximum returned view characters before clipping (default 16000). */
  maxOutputChars?: number
  /** Model-facing tool description. */
  description?: string
  /** Require local absolute paths like the canonical editor contract (default true). */
  requireAbsolutePath?: boolean
}

/** Runtime configuration schema for the string-replacement editor tool. */
export const Config: z<Config> = z.object({
  maxOutputChars: z.number().default(16_000),
  description: z.string().default(DEFAULT_DESCRIPTION),
  requireAbsolutePath: z.boolean().default(true),
})

/** Register one `str_replace_editor` tool over `ctx.fs`. */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    maxOutputChars: config.maxOutputChars ?? 16_000,
    description: config.description ?? DEFAULT_DESCRIPTION,
    requireAbsolutePath: config.requireAbsolutePath ?? true,
  }
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) {
    throw new Error('tool-str-replace-editor: maxOutputChars must be a positive safe integer')
  }
  if (resolved.description.trim().length === 0) {
    throw new Error('tool-str-replace-editor: description must be non-empty')
  }
  registerStrReplaceEditor(ctx, resolved)
}
