/** Verify and append-seal the frozen Agent Note archive. */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_NOTE_CLASSES, agentNoteRoot } from './agent-note-tree.ts'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  type ArchiveManifest,
} from './archived-agent-notes.ts'

const args = process.argv.slice(2)
const writeMode = args.length === 1 && args[0] === '--write'
if (args.length > 0 && !writeMode) {
  console.error('verify-archived-agent-notes: usage: tsx scripts/verify-archived-agent-notes.ts [--write]')
  process.exit(1)
}

const archiveRoot = resolve(agentNoteRoot, 'archived')
const manifestPath = resolve(archiveRoot, 'manifest.json')
const errors: string[] = []
const allowedRootFiles = new Set(['AGENTS.md', 'manifest.json'])
const kinds = new Set<string>()

if (!existsSync(resolve(archiveRoot, 'AGENTS.md'))) errors.push('archived/AGENTS.md is required')
const artifacts = new Map<string, Buffer>()
for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
  if (entry.isFile()) {
    if (!allowedRootFiles.has(entry.name)) errors.push(`archived/${entry.name}: unexpected root file`)
    continue
  }
  if (!entry.isDirectory()) {
    errors.push(`archived/${entry.name}: only regular files and kind directories are allowed`)
    continue
  }
  if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(entry.name)) {
    errors.push(`archived/${entry.name}/: unknown Agent Note kind`)
    continue
  }
  kinds.add(entry.name)
  for (const child of readdirSync(resolve(archiveRoot, entry.name), { withFileTypes: true })) {
    const rel = `${entry.name}/${child.name}`
    if (!child.isFile()) {
      errors.push(`${rel}: archived kind directories contain regular files only`)
      continue
    }
    artifacts.set(rel, readFileSync(resolve(archiveRoot, rel)))
  }
}
for (const kind of AGENT_NOTE_CLASSES) {
  if (!kinds.has(kind)) errors.push(`archived/${kind}/: required kind directory is missing`)
}
errors.push(...validateArchiveArtifacts(artifacts))

let manifest: ArchiveManifest = { version: 1, files: {} }
if (existsSync(manifestPath)) {
  try {
    manifest = parseArchiveManifest(readFileSync(manifestPath, 'utf8'))
  } catch (error: unknown) {
    errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`)
  }
} else if (!writeMode) {
  errors.push('archived/manifest.json is required; seal new artifacts with `pnpm run verify-archived-agent-notes --write`')
}

const extended = extendArchiveManifest(manifest, artifacts)
errors.push(...extended.errors)
if (!writeMode) {
  for (const path of extended.added) errors.push(`${path}: archived artifact is not sealed in manifest.json`)
}

if (errors.length > 0) {
  console.error('verify-archived-agent-notes: archive contract violated:')
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

if (writeMode) {
  const rendered = renderArchiveManifest(extended.files)
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== rendered) {
    writeFileSync(manifestPath, rendered)
  }
  console.log(`verify-archived-agent-notes: sealed ${extended.added.length} new artifact(s); existing seals unchanged.`)
} else {
  console.log(`verify-archived-agent-notes: ${artifacts.size} frozen artifact(s) checked across ${kinds.size} kind(s).`)
}
