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
const LIMITATIONS_HEADING = '## Known Limitations and Deferred Work'
const TABLE_HEADER = '| Context surface | What the model sees | Token effect |'
const TABLE_DIVIDER = '|---|---|---|'
const H2_HEADING = /^## .+$/

interface Failure {
  path: string
  message: string
}

interface Line {
  index: number
  raw: string
}

/** Split Markdown into prose lines, excluding fenced code that may quote the contract. */
function proseLines(text: string): Line[] {
  let fence: { marker: '`' | '~'; length: number } | undefined
  const kept: Line[] = []
  text.split('\n').forEach((raw, i) => {
    const token = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
    if (token !== undefined) {
      const marker = token[0] as '`' | '~'
      if (fence === undefined) {
        fence = { marker, length: token.length }
      } else if (marker === fence.marker && token.length >= fence.length) {
        fence = undefined
      }
      return
    }
    if (fence === undefined) kept.push({ index: i + 1, raw })
  })
  return kept
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

  const lines = proseLines(readFileSync(abs, 'utf8'))
  const h2Headings = lines.filter(line => H2_HEADING.test(line.raw))
  const modelHeadings = h2Headings.filter(line => line.raw === HEADING)
  if (modelHeadings.length !== 1) {
    failures.push({
      path: readme,
      message: modelHeadings.length === 0 ? `missing ${HEADING}` : `contains ${modelHeadings.length} copies of ${HEADING}`,
    })
    continue
  }

  const modelHeading = modelHeadings[0] as Line
  const modelH2Index = h2Headings.indexOf(modelHeading)
  const limitationsH2Index = h2Headings.findIndex(heading => heading.raw === LIMITATIONS_HEADING)
  if (limitationsH2Index >= 0) {
    if (modelH2Index !== h2Headings.length - 2 || limitationsH2Index !== h2Headings.length - 1) {
      failures.push({
        path: readme,
        message: `${HEADING} and ${LIMITATIONS_HEADING} must be the final two H2 sections, in that order`,
      })
      continue
    }
  } else if (modelH2Index !== h2Headings.length - 1) {
    failures.push({ path: readme, message: `${HEADING} must be the final H2 when ${LIMITATIONS_HEADING} is absent` })
    continue
  }

  const body = lines.slice(lines.indexOf(modelHeading) + 1)
  const nextH2 = body.findIndex(line => H2_HEADING.test(line.raw))
  const section = nextH2 < 0 ? body : body.slice(0, nextH2)
  const headers = section.filter(line => line.raw === TABLE_HEADER)
  const header = headers[0]
  const headerIndex = header === undefined ? -1 : section.indexOf(header)
  if (headers.length !== 1 || headerIndex < 0 || section[headerIndex + 1]?.raw !== TABLE_DIVIDER) {
    failures.push({ path: readme, message: `must contain the exact table header ${TABLE_HEADER}` })
    continue
  }

  const rows: Line[] = []
  for (const line of section.slice(headerIndex + 2)) {
    if (!line.raw.startsWith('|')) break
    rows.push(line)
  }
  if (rows.length === 0) {
    failures.push({ path: readme, message: 'Model Experience table must contain at least one data row' })
    continue
  }
  for (const row of rows) {
    const cells = row.raw.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 3 || cells.some(cell => cell.length === 0)) {
      failures.push({ path: readme, message: `line ${row.index}: invalid three-column Model Experience row: ${row.raw}` })
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
