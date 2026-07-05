/**
 * Doc-sync gate: enforce the RFC in-file format
 * ([README.md § The file format](../docs/rfc/README.md), the contract; rationale in
 * [the uniform-format RFC](../docs/rfc/implemented/process/2026-07-05-uniform-rfc-format.md)).
 * The classification gate owns WHERE a file sits and how it is named; this gate
 * owns what is INSIDE: the header block, the per-lifecycle body skeleton, and
 * the Alternatives-considered mandate.
 *
 * Per English RFC (`.zh.md` counterparts are the pairing gate's concern):
 *
 * 1. HEADER — line 1 is `# RFC: <title>`, line 2 blank, line 3 the one
 *    `Status:` line in the file, line 4 blank. The status is the dateless enum
 *    matching the lifecycle folder: `Status: proposed`, `Status: implemented`,
 *    or `Status: rejected — <reason>`.
 * 2. SKELETON — the first `##` section is `## Problem`; the lifecycle's
 *    required sections are present under their canonical names (`proposed/`:
 *    Proposal, Acceptance criteria, Risks; `implemented/`: Decision,
 *    Consequences; `rejected/`: Proposal); `implemented/` must not carry the
 *    proposal-era headings (Proposal, Plan, Migration plan, Acceptance
 *    criteria) that the docs standard's slop checklist outlaws there.
 * 3. ALTERNATIVES — `## Alternatives considered` is present, or the file is a
 *    pre-format RFC (dated before the format landed) carrying the exact
 *    grandfather comment instead. Carrying both, or grandfathering a
 *    post-format RFC, fails.
 * 4. DEBT MARKER — the retired legacy-format debt comment may not reappear.
 *
 * Checker, not fixer: it reports and never rewrites.
 * Run: `tsx scripts/verify-rfc-format.ts`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rfcRoot, walkRfcTree } from './rfc-index.ts'

/** The date the format contract landed; the grandfather comment is valid only before it. */
const FORMAT_ADOPTED = '2026-07-05'

/** The exact comment a pre-format RFC carries in place of `## Alternatives considered`. */
const GRANDFATHER = '<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->'

/** The retired debt marker that flagged pre-format bodies; banned so it cannot creep back. */
const LEGACY_MARKER = 'XXX: legacy ADR/RFC body format'

/** Status-line grammar per lifecycle folder. */
const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
}

/** Required `##` headings per lifecycle, beyond the universal `## Problem` opener. */
const REQUIRED: Record<string, string[]> = {
  proposed: ['## Proposal', '## Acceptance criteria', '## Risks'],
  implemented: ['## Decision', '## Consequences'],
  rejected: ['## Proposal'],
}

/** Headings banned in `implemented/` — proposal-era spec-speak per the slop checklist. */
const BANNED_IMPLEMENTED = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i

const { rfcs, errors } = walkRfcTree()

for (const rfc of rfcs) {
  const fail = (msg: string): void => {
    errors.push(`format: ${rfc.rel} — ${msg}`)
  }
  const lines = readFileSync(resolve(rfcRoot, rfc.rel), 'utf8').split('\n')
  // Content scans ignore fenced code blocks: an RFC may legitimately QUOTE a
  // status line, a banned heading, or the grandfather comment inside a fence
  // (the README's own format section does), and only real prose counts.
  let inFence = false
  const prose = lines.filter((l) => {
    if (l.startsWith('```')) {
      inFence = !inFence
      return false
    }
    return !inFence
  })

  if (!/^# RFC: \S/.test(lines[0] ?? '')) fail('line 1 must be `# RFC: <title>`')
  if (lines[1] !== '') fail('line 2 must be blank')
  const status = STATUS[rfc.lifecycle]
  if (status !== undefined && !status.test(lines[2] ?? '')) {
    fail(`line 3 must match the ${rfc.lifecycle} status grammar (${String(status)})`)
  }
  if (lines[3] !== '') fail('line 4 must be blank')
  const statusLines = prose.filter(l => l.startsWith('Status:') && l !== lines[2])
  if (statusLines.length > 0 || prose.filter(l => l === lines[2]).length > 1) {
    fail('the line-3 `Status:` line must be the only one in the file')
  }

  const h2s = prose.filter(l => l.startsWith('## ')).map(l => l.trimEnd())
  if (h2s[0] !== '## Problem') fail(`the first section must be \`## Problem\` (got ${JSON.stringify(h2s[0] ?? '<none>')})`)
  for (const required of REQUIRED[rfc.lifecycle] ?? []) {
    if (!h2s.includes(required)) fail(`missing the required \`${required}\` section`)
  }
  if (rfc.lifecycle === 'implemented') {
    for (const h2 of h2s.filter(h => BANNED_IMPLEMENTED.test(h))) {
      fail(`\`${h2}\` is a proposal-era heading; an implemented RFC states what is (fold it into Decision/Consequences/Testing)`)
    }
  }

  const hasSection = h2s.includes('## Alternatives considered')
  const hasGrandfather = prose.includes(GRANDFATHER)
  if (hasSection && hasGrandfather) fail('carries both `## Alternatives considered` and the grandfather comment — drop the comment')
  if (!hasSection && !hasGrandfather) fail('missing `## Alternatives considered` (a pre-format RFC whose alternatives are not reconstructible carries the grandfather comment instead — see docs/rfc/README.md § The file format)')
  if (hasGrandfather && rfc.date >= FORMAT_ADOPTED) fail(`the grandfather comment is only valid for RFCs dated before ${FORMAT_ADOPTED}`)

  if (prose.some(l => l.includes(LEGACY_MARKER))) fail('carries the retired legacy-format debt marker')
}

if (errors.length === 0) {
  console.log(`verify-rfc-format: ${rfcs.length} RFC(s) checked, all conform to docs/rfc/README.md § The file format.`)
  process.exit(0)
}

console.error('verify-rfc-format: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
