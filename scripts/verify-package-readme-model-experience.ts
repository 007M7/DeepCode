/**
 * Doc-sync gate: require every workspace package README to explain its exact
 * model-visible context surface and token behavior in the canonical table.
 *
 * Run: `tsx scripts/verify-package-readme-model-experience.ts`.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const HEADING = '## Model Experience'
const HEADING_PATTERN = /^## Model Experience$/gm
const TABLE_HEADER = '| Context surface | What the model sees | Token effect |'
const TABLE_DIVIDER = '|---|---|---|'

interface Failure {
  path: string
  message: string
}

const failures: Failure[] = []
const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).sort()

for (const packageJson of packageJsons) {
  const readme = packageJson.replace(/package\.json$/, 'README.md')
  const abs = resolve(root, readme)
  if (!existsSync(abs)) {
    failures.push({ path: readme, message: `missing package README; add one with ${HEADING}` })
    continue
  }

  const source = readFileSync(abs, 'utf8')
  const matches = [...source.matchAll(HEADING_PATTERN)]
  if (matches.length !== 1) {
    failures.push({
      path: readme,
      message: matches.length === 0 ? `missing ${HEADING}` : `contains ${matches.length} copies of ${HEADING}`,
    })
    continue
  }

  const match = matches[0]
  if (match?.index === undefined) {
    failures.push({ path: readme, message: `could not locate ${HEADING}` })
    continue
  }
  const headingIndex = match.index
  const bodyStart = headingIndex + HEADING.length
  const nextHeadingOffset = source.slice(bodyStart).search(/^## /m)
  const section = source.slice(bodyStart, nextHeadingOffset < 0 ? undefined : bodyStart + nextHeadingOffset)
  const lines = section.split('\n')
  const headerIndex = lines.indexOf(TABLE_HEADER)
  if (headerIndex < 0 || lines[headerIndex + 1] !== TABLE_DIVIDER) {
    failures.push({ path: readme, message: `must contain the exact table header ${TABLE_HEADER}` })
    continue
  }

  const rows = lines.slice(headerIndex + 2).filter(line => line.startsWith('|'))
  if (rows.length === 0) {
    failures.push({ path: readme, message: 'Model Experience table must contain at least one data row' })
    continue
  }
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 3 || cells.some(cell => cell.length === 0)) {
      failures.push({ path: readme, message: `invalid three-column Model Experience row: ${row}` })
    }
  }
}

if (failures.length === 0) {
  console.log(`verify-package-readme-model-experience: ${packageJsons.length} README(s) carry the canonical ${HEADING} table.`)
  process.exit(0)
}

console.error('verify-package-readme-model-experience failed:')
for (const failure of failures) {
  console.error(`  ${relative(root, resolve(root, failure.path))}: ${failure.message}`)
}
process.exit(1)
