/**
 * Doc-sync gate for package README Model Experience sections. It validates
 * audited package classifications, context-surface fields, package-owned text
 * blocks, generated-catalog links, and final-section order. See the
 * [Model Experience RFC](../docs/rfc/implemented/process/2026-07-12-package-model-experience-contract.md).
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { markdownHeadingLines, markdownProseLines, type MarkdownProseLine } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')
const HEADING = '## Model Experience'
const LIMITATIONS_HEADING = '## Known Limitations and Deferred Work'
const MODEL_VIEW_LABEL = '**What the model sees**'
const TOKEN_EFFECT_LABEL = '**Token effect**'

type SentenceKind = 'none' | 'indirect'

interface SentenceContract {
  kind: SentenceKind
  reason: string
}

/**
 * Generic packages whose public contract is model-agnostic. Their READMEs omit
 * Model Experience entirely; the reason stays here as reviewable audit evidence
 * so an absent section cannot be mistaken for forgotten documentation.
 */
const NO_MODEL_EXPERIENCE_SECTION: Readonly<Record<string, string>> = {
  'packages/core/scope': 'The package is a model-agnostic registration and lifecycle primitive; model-facing consumers own any context selection.',
  'packages/util/brand': 'The package is a type-only primitive erased at compile time.',
  'packages/util/paths': 'The package only resolves harness-owned host paths; model-facing consumers own any rendered use.',
}

/**
 * Packages whose Model Experience is simple enough for one gated sentence.
 * Every other package must carry canonical context-surface blocks. A package
 * moves on or off this list with the change to its context behavior.
 */
const SENTENCE_MODEL_EXPERIENCE: Readonly<Record<string, SentenceContract>> = {
  'packages/bash/bash': { kind: 'indirect', reason: 'The service interface delegates all model rendering to dsh-tool-bash.' },
  'packages/bash/bash-local': { kind: 'indirect', reason: 'The executor backend delegates model rendering to dsh-tool-bash.' },
  'packages/code-runtime/code-runtime': { kind: 'indirect', reason: 'The service interface delegates model rendering to Code Mode in dsh-tools.' },
  'packages/code-runtime/code-runtime-worker': { kind: 'indirect', reason: 'The worker backend delegates model rendering to Code Mode in dsh-tools.' },
  'packages/examples/agent-spine-demo': { kind: 'indirect', reason: 'The bundle only mounts model-facing child plugins.' },
  'packages/fs/fs': { kind: 'indirect', reason: 'The service interface delegates model rendering to dsh-tool-fs.' },
  'packages/fs/fs-local': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-fs.' },
  'packages/hooks/hook-protocol': { kind: 'indirect', reason: 'Only the hook bridge plugins render decoded hook output to a model.' },
  'packages/llm/llm': { kind: 'none', reason: 'The adapter registry forwards already-assembled requests unchanged.' },
  'packages/sandbox/sandbox-local': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-bash-sandbox and dsh-tool-bash.' },
  'packages/sdk/create-sdk': { kind: 'indirect', reason: 'The initializer only writes project files; selected runtime plugins provide the generated project model surface.' },
  'packages/sdk/helper': { kind: 'none', reason: 'The project domain edits files and registers no live agent or model surface.' },
  'packages/sdk/scripts': { kind: 'indirect', reason: 'The launcher delegates model context to the loaded project plugin tree.' },
  'packages/session-query/session-query': { kind: 'none', reason: 'The trusted query service exposes cloned records only to callers and registers no model surface.' },
  'packages/skill/skill': { kind: 'indirect', reason: 'The provider registry delegates model rendering to dsh-tool-skill.' },
  'packages/skill/skill-local': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-skill.' },
  'packages/spill/spill': { kind: 'indirect', reason: 'The storage seam delegates model rendering to spill consumers.' },
  'packages/spill/spill-local': { kind: 'indirect', reason: 'The storage backend delegates model rendering to spill consumers.' },
  'packages/subagent/subagent': { kind: 'indirect', reason: 'The provider registry delegates parent-model rendering to dsh-tool-subagent.' },
  'packages/subagent/subagent-subprocess': { kind: 'indirect', reason: 'Only process-based subagent backends compose a child model request.' },
  'packages/support/acp-snapshot': { kind: 'none', reason: 'The test harness observes and normalizes transcripts without changing live requests.' },
  'packages/support/agent-loop-testkit': { kind: 'none', reason: 'The test helper mounts services but neither drives nor modifies model requests.' },
  'packages/support/invariants': { kind: 'none', reason: 'The observer validates requests but never rewrites their context.' },
  'packages/support/loader-smoke': { kind: 'none', reason: 'The test harness observes child-process streams without changing live requests.' },
  'packages/support/llm-replay': { kind: 'none', reason: 'The keyless adapter invokes no provider model.' },
  'packages/support/subagent-mock': { kind: 'indirect', reason: 'Only dsh-tool-subagent renders its configured test outcome.' },
  'packages/tasks/tasks': { kind: 'indirect', reason: 'Producer and control-surface plugins own all model rendering over the task registry.' },
  'packages/examples/acp-demo': { kind: 'indirect', reason: 'The app bundle delegates request composition to dsh-agent-spine-demo and dsh-acp.' },
  'packages/ui/app-boot': { kind: 'indirect', reason: 'Only the loaded plugin tree contributes model context.' },
  'packages/examples/jsonrpc-demo': { kind: 'indirect', reason: 'Only the externally configured plugin tree contributes model context.' },
  'packages/ui/permission': { kind: 'indirect', reason: 'The service writes mechanism events rendered by dsh-user-approval and dsh-tool-bash.' },
  'packages/ui/user-interaction': { kind: 'indirect', reason: 'Model-facing consumers render provider answers and seam errors.' },
  'packages/util/home': { kind: 'indirect', reason: 'Only dsh-tool-bash exposes the resolved home to model commands.' },
  'packages/util/timeout': { kind: 'indirect', reason: 'Only timeout consumers render timeout outcomes.' },
  'packages/util/retention': { kind: 'indirect', reason: 'Only retention consumers render retained content and omission metadata.' },
  'packages/web/web': { kind: 'indirect', reason: 'The provider registry delegates model rendering to dsh-tool-web.' },
  'packages/web/web-fetch-local': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-web.' },
  'packages/web/web-search-exa': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-web.' },
  'packages/workflow/workflow': { kind: 'indirect', reason: 'The service delegates parent and child model rendering to its consumer and engine.' },
}

interface Failure {
  path: string
  message: string
}

type Line = MarkdownProseLine

interface ContextSurface {
  heading: Line
  modelView: Line
  tokenEffect: Line
  title: string
  verbatimBlocks: number
}

/** Validate H4-plus-markdown literals nested after one context surface's fields. */
function validateNestedVerbatim(raw: readonly string[]): { blocks: number; error?: string } {
  let cursor = 0
  while (raw[cursor]?.trim().length === 0) cursor += 1
  if (cursor === raw.length) return { blocks: 0 }

  let blocks = 0
  const fragments = new Set<string>()
  while (true) {
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (cursor === raw.length) break
    if (!/^#### \S/.test(raw[cursor] ?? '')) {
      return { blocks, error: 'content after Token effect must be a titled H4 verbatim block' }
    }
    const title = (raw[cursor] as string).slice('#### '.length)
    const fragment = headingFragment(title)
    if (fragment.length === 0) return { blocks, error: 'verbatim H4 title must be non-empty' }
    if (fragments.has(fragment)) {
      return { blocks, error: `verbatim H4 title ${JSON.stringify(title)} is duplicated within its context surface` }
    }
    fragments.add(fragment)
    cursor += 1
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (raw[cursor] !== '```markdown') {
      return { blocks, error: 'each nested verbatim H4 requires an exact ```markdown fence' }
    }
    cursor += 1
    const contentStart = cursor
    while (cursor < raw.length && raw[cursor] !== '```') cursor += 1
    if (cursor === raw.length) return { blocks, error: 'unterminated nested ```markdown fence' }
    if (cursor === contentStart) return { blocks, error: 'nested ```markdown fence must not be empty' }
    cursor += 1
    blocks += 1
  }
  return { blocks }
}

/** GitHub-style fragment for the simple ASCII H4 titles allowed by this contract. */
function headingFragment(title: string): string {
  return title.toLowerCase().replaceAll('`', '').replaceAll(/[^a-z0-9 _-]/g, '').trim().replaceAll(/\s+/g, '-')
}

/** A direct stable system-prompt contribution, as named by the README contract. */
function isDirectSystemPromptSurface(title: string): boolean {
  return /\bsystem prompt\b/i.test(title)
}

/** Anchored generated-catalog links in one model-view field. */
function toolCatalogLinkFragments(text: string): string[] {
  return [...text.matchAll(/\]\(\.\.\/\.\.\/\.\.\/docs\/tool-catalog\.md#([a-z0-9_-]+)\)/g)]
    .map(match => match[1] as string)
}

const toolCatalogFragments = new Set<string>()
for (const line of readFileSync(resolve(root, 'docs/tool-catalog.md'), 'utf8').split('\n')) {
  const title = /^## (.+)$/.exec(line)?.[1]
  if (title !== undefined) toolCatalogFragments.add(headingFragment(title))
}

const failures: Failure[] = []
const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split(sep).join('/')).sort()
const scannedPackages = new Set(packageJsons.map(path => path.slice(0, -'/package.json'.length)))
let structuredCount = 0
let contextSurfaceCount = 0
let omittedSectionCount = 0
let explainedNoneCount = 0
let indirectCount = 0
let verbatimBlockCount = 0
let systemPromptSurfaceCount = 0
let toolSchemaSurfaceCount = 0

for (const [pkg, reason] of Object.entries(NO_MODEL_EXPERIENCE_SECTION)) {
  if (!scannedPackages.has(pkg)) {
    failures.push({ path: `${pkg}/README.md`, message: 'no-section allowlist entry does not name a scanned package' })
  }
  if (reason.trim().length === 0) {
    failures.push({ path: `${pkg}/README.md`, message: 'no-section allowlist entry must retain its audit justification' })
  }
  if (SENTENCE_MODEL_EXPERIENCE[pkg] !== undefined) {
    failures.push({ path: `${pkg}/README.md`, message: 'package cannot appear in both Model Experience allowlists' })
  }
}

for (const [pkg, contract] of Object.entries(SENTENCE_MODEL_EXPERIENCE)) {
  if (!scannedPackages.has(pkg)) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry does not name a scanned package' })
  }
  if (contract.reason.trim().length === 0) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry must justify why structured context surfaces are unnecessary' })
  }
}

for (const packageJson of packageJsons) {
  const pkg = packageJson.slice(0, -'/package.json'.length)
  const readme = packageJson.replace(/package\.json$/, 'README.md')
  const abs = resolve(root, readme)
  if (!existsSync(abs)) {
    failures.push({ path: readme, message: 'missing package README' })
    continue
  }

  const text = readFileSync(abs, 'utf8')
  const rawLines = text.split('\n')
  const lines = markdownProseLines(text)
  const headings = markdownHeadingLines(text)
  const h2Headings = headings.filter(heading => heading.depth === 2)
  const modelExperienceHeadings = headings.filter(heading => heading.text
    .trim().replaceAll(/\s+/g, ' ').toLowerCase() === 'model experience')
  const modelHeadings = modelExperienceHeadings.filter(heading => heading.depth === 2 && heading.raw === HEADING)
  if (NO_MODEL_EXPERIENCE_SECTION[pkg] !== undefined) {
    if (modelExperienceHeadings.length !== 0) {
      for (const heading of modelExperienceHeadings) {
        failures.push({ path: readme, message: `line ${heading.index}: audited model-agnostic package must omit every Model Experience heading; found ${JSON.stringify(heading.raw)}` })
      }
    } else {
      omittedSectionCount += 1
    }
    continue
  }
  const nonCanonicalModelHeading = modelExperienceHeadings.find(heading => heading.depth !== 2 || heading.raw !== HEADING)
  if (nonCanonicalModelHeading !== undefined) {
    failures.push({ path: readme, message: `line ${nonCanonicalModelHeading.index}: non-canonical Model Experience heading ${JSON.stringify(nonCanonicalModelHeading.raw)}; use exactly ${JSON.stringify(HEADING)}` })
    continue
  }
  const modelHeading = modelHeadings.at(0)
  if (modelHeading === undefined) {
    failures.push({
      path: readme,
      message: `missing ${HEADING}`,
    })
    continue
  }
  if (modelHeadings.length !== 1) {
    failures.push({ path: readme, message: `contains ${modelHeadings.length} copies of ${HEADING}` })
    continue
  }
  const modelH2Index = h2Headings.indexOf(modelHeading)
  const limitationsH2Index = h2Headings.findIndex(heading => heading.depth === 2 && heading.raw === LIMITATIONS_HEADING)
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

  const modelHeadingAt = lines.findIndex(line => line.index === modelHeading.index)
  const body = lines.slice(modelHeadingAt + 1)
  const h2Lines = new Set(h2Headings.map(heading => heading.index))
  const nextH2 = body.findIndex(line => h2Lines.has(line.index))
  const section = nextH2 < 0 ? body : body.slice(0, nextH2)
  const nextH2Line = nextH2 < 0 ? rawLines.length + 1 : (body[nextH2] as Line).index
  const rawSection = rawLines.slice(modelHeading.index, nextH2Line - 1)
  const content = section.filter(line => line.raw.trim().length > 0)
  const sentenceContract = SENTENCE_MODEL_EXPERIENCE[pkg]
  if (sentenceContract !== undefined) {
    const pattern = sentenceContract.kind === 'none' ? /^None, as .+\.$/ : /^Indirectly, through .+\.$/
    const rawContent = rawSection.filter(line => line.trim().length > 0)
    if (content.length !== 1 || rawContent.length !== 1 || !pattern.test(content[0]?.raw ?? '')) {
      const prefix = sentenceContract.kind === 'none' ? 'None, as ' : 'Indirectly, through '
      failures.push({ path: readme, message: `must contain exactly one sentence beginning ${JSON.stringify(prefix)} and ending with a period` })
      continue
    }
    if (sentenceContract.kind === 'none') explainedNoneCount += 1
    else indirectCount += 1
    continue
  }

  const shortSentence = content.find(line => line.raw === 'None.' || /^None, as |^Indirectly, through /.test(line.raw))
  if (shortSentence !== undefined) {
    failures.push({ path: readme, message: `line ${shortSentence.index}: short Model Experience form requires an audited entry in SENTENCE_MODEL_EXPERIENCE` })
    continue
  }

  const surfaceStarts = content
    .map((line, index) => ({ line, index }))
    .filter(entry => /^### \S/.test(entry.line.raw))
  if (surfaceStarts.length === 0 || surfaceStarts[0]?.index !== 0) {
    failures.push({ path: readme, message: 'must contain one or more complete context-surface blocks' })
    continue
  }

  const surfaces: ContextSurface[] = []
  const surfaceFragments = new Set<string>()
  let surfaceError = false
  for (let surfaceIndex = 0; surfaceIndex < surfaceStarts.length; surfaceIndex += 1) {
    const start = surfaceStarts[surfaceIndex] as { line: Line; index: number }
    const end = surfaceStarts[surfaceIndex + 1]?.index ?? content.length
    const entries = content.slice(start.index, end)
    const heading = entries[0] as Line
    const modelView = entries[1]
    const tokenEffect = entries[2]
    const title = heading.raw.slice('### '.length)
    const fragment = headingFragment(title)
    if (fragment.length === 0) {
      failures.push({ path: readme, message: `line ${heading.index}: each context surface requires a non-empty H3 heading` })
      surfaceError = true
      break
    }
    if (surfaceFragments.has(fragment)) {
      failures.push({ path: readme, message: `line ${heading.index}: duplicate context-surface link fragment ${JSON.stringify(fragment)}` })
      surfaceError = true
      break
    }
    if (modelView === undefined || !modelView.raw.startsWith(`${MODEL_VIEW_LABEL}: `) || modelView.raw.slice(`${MODEL_VIEW_LABEL}: `.length).trim().length === 0) {
      failures.push({ path: readme, message: `line ${modelView?.index ?? heading.index}: context surface requires non-empty ${MODEL_VIEW_LABEL}: text` })
      surfaceError = true
      break
    }
    if (tokenEffect === undefined || !tokenEffect.raw.startsWith(`${TOKEN_EFFECT_LABEL}: `) || tokenEffect.raw.slice(`${TOKEN_EFFECT_LABEL}: `.length).trim().length === 0) {
      failures.push({ path: readme, message: `line ${tokenEffect?.index ?? heading.index}: context surface requires non-empty ${TOKEN_EFFECT_LABEL}: text` })
      surfaceError = true
      break
    }
    if ((surfaceIndex === 0 && heading.index !== modelHeading.index + 2)
      || rawLines[heading.index - 2]?.trim().length !== 0
      || modelView.index !== heading.index + 2
      || tokenEffect.index !== modelView.index + 2) {
      failures.push({ path: readme, message: `line ${heading.index}: context-surface heading and fields require one blank line between each element` })
      surfaceError = true
      break
    }
    const unexpected = entries.slice(3).find(line => !/^#### \S/.test(line.raw))
    if (unexpected !== undefined) {
      failures.push({ path: readme, message: `line ${unexpected.index}: content after ${TOKEN_EFFECT_LABEL} must be a titled H4 plus \`markdown\` fence inside this context surface` })
      surfaceError = true
      break
    }
    const nextHeadingLine = surfaceStarts[surfaceIndex + 1]?.line.index ?? nextH2Line
    const verbatim = validateNestedVerbatim(rawLines.slice(tokenEffect.index, nextHeadingLine - 1))
    if (verbatim.error !== undefined) {
      failures.push({ path: readme, message: `line ${tokenEffect.index}: ${verbatim.error}` })
      surfaceError = true
      break
    }
    if (entries.length - 3 !== verbatim.blocks) {
      failures.push({ path: readme, message: `line ${tokenEffect.index}: every nested H4 must own exactly one \`markdown\` fence` })
      surfaceError = true
      break
    }
    if (/\]\(#[^)]+\)/.test(modelView.raw) || /\]\(#[^)]+\)/.test(tokenEffect.raw)) {
      failures.push({ path: readme, message: `line ${heading.index}: Model Experience fields must not link between local subsections; nest the H4 in its owning H3` })
      surfaceError = true
      break
    }
    surfaceFragments.add(fragment)
    surfaces.push({ heading, modelView, tokenEffect, title, verbatimBlocks: verbatim.blocks })
  }
  if (surfaceError) continue

  const promptWithoutVerbatim = surfaces.find(surface => isDirectSystemPromptSurface(surface.title)
    && surface.verbatimBlocks === 0)
  if (promptWithoutVerbatim !== undefined) {
    failures.push({ path: readme, message: `line ${promptWithoutVerbatim.heading.index}: system-prompt surface must contain a titled H4 plus verbatim \`markdown\` block` })
    continue
  }
  const hasConcreteLiteral = surfaces.some(surface => surface.verbatimBlocks > 0
    || surface.modelView.raw.includes('`')
    || surface.tokenEffect.raw.includes('`')
    || toolCatalogLinkFragments(surface.modelView.raw).length > 0)
  if (!hasConcreteLiteral) {
    failures.push({ path: readme, message: 'structured Model Experience must ground at least one surface with inline code, a nested `markdown` block, or an anchored tool-catalog link' })
    continue
  }
  let catalogError = false
  for (const surface of surfaces) {
    if (!/\bschemas?\b/i.test(surface.title)) continue
    const fragments = toolCatalogLinkFragments(surface.modelView.raw)
    if (fragments.length === 0) {
      failures.push({ path: readme, message: `line ${surface.heading.index}: tool-schema surface must link an anchored section of ../../../docs/tool-catalog.md` })
      catalogError = true
      break
    }
    const invalid = fragments.find(fragment => !toolCatalogFragments.has(fragment))
    if (invalid !== undefined) {
      failures.push({ path: readme, message: `line ${surface.modelView.index}: tool-catalog link fragment ${JSON.stringify(invalid)} does not name an H2 section` })
      catalogError = true
      break
    }
  }
  if (catalogError) continue
  verbatimBlockCount += surfaces.reduce((total, surface) => total + surface.verbatimBlocks, 0)
  contextSurfaceCount += surfaces.length
  systemPromptSurfaceCount += surfaces.filter(surface => isDirectSystemPromptSurface(surface.title)).length
  toolSchemaSurfaceCount += surfaces.filter(surface => /\bschemas?\b/i.test(surface.title)).length
  structuredCount += 1
}

if (failures.length === 0) {
  console.log(`verify-package-readme-model-experience: ${packageJsons.length} README(s) checked (${omittedSectionCount} audited omissions, ${structuredCount} structured, ${contextSurfaceCount} context surfaces, ${systemPromptSurfaceCount} fenced system-prompt surfaces, ${toolSchemaSurfaceCount} catalog-linked tool-schema surfaces, ${explainedNoneCount} explained none, ${indirectCount} indirect, ${verbatimBlockCount} verbatim markdown blocks), all conform.`)
  process.exit(0)
}

console.error('verify-package-readme-model-experience failed:')
for (const failure of failures) {
  console.error(`  ${relative(root, resolve(root, failure.path))}: ${failure.message}`)
}
process.exit(1)
