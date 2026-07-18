// Rubrics — pure model. The renderer (rubrics-page.js) uses these helpers
// so we can unit-test the catalog projection, task-category tree, checklist
// preview, and per-rubric identity math without a DOM.
//
// Shape lock (per docs/design-refs/ia-design-pack-179.md §3 Rubrics + the RL
// plan's 3-stage rubric goal):
//
//   catalog = ordered list of task-category groups; each group ordered list
//     of rubric row summaries { id, group, name, template, checklist[preview],
//     lastEdited, forkedFrom?, attachedToBench[] }.
//
//   template is one of:
//     - 'fixed'        (Bug fix: 5 static checklist items)
//     - 'per-prompt'   (SVG gen: LLM composes checklist per prompt)
//     - 'multi-turn'   (5 fixed multi-turn dims)
//     - 'code-review'  (mixed static + code executor)
//
//   Each rubric loaded from disk is a SKILL.md-shaped file:
//     ---
//     name: bug-fix
//     group: fix-optimize
//     template: fixed
//     executor: llm-judge | code
//     ---
//     ## Checklist
//     - reproduces failure
//     - patch is minimal
//     - no regressions
//
// This module reads fixture rubrics + user overlay rubrics and merges them
// into a stable catalog projection. It does NOT do disk I/O; the DOM layer
// (or a preload IPC) hands it JSON blobs.

'use strict'

// The 7 task categories from the RL plan; ordering is intentional (research
// flow: gen → understand → fix → translate → SE → interaction → repo).
// Subtask names come from the RL plan (28 total).
const TASK_CATEGORIES = [
  {
    id: 'code-gen',
    name: 'Code generation',
    hint: 'Write new code from a spec',
    subtasks: [
      'function-completion',
      'class-scaffold',
      'algorithm-implement',
      'sql-query',
    ],
  },
  {
    id: 'code-comprehension',
    name: 'Code comprehension',
    hint: 'Read code and explain / trace / summarize',
    subtasks: [
      'function-summary',
      'call-graph-trace',
      'behavior-diff',
      'symbol-usage',
    ],
  },
  {
    id: 'fix-optimize',
    name: 'Fix and optimize',
    hint: 'Reproduce a bug, patch it, or improve perf',
    subtasks: [
      'bug-repro',
      'bug-fix',
      'perf-optimize',
      'code-refactor',
    ],
  },
  {
    id: 'translate-migrate',
    name: 'Translate and migrate',
    hint: 'Cross-language translation, framework migration',
    subtasks: [
      'lang-port',
      'api-migrate',
      'dep-upgrade',
      'schema-migrate',
    ],
  },
  {
    id: 'se-process',
    name: 'SE process',
    hint: 'Reviews, PRs, tests, docs',
    subtasks: [
      'code-review',
      'test-authoring',
      'doc-generation',
      'pr-summary',
    ],
  },
  {
    id: 'interaction-reasoning',
    name: 'Interaction and reasoning',
    hint: 'Multi-turn feedback loops, SVG/plot iteration, planning',
    subtasks: [
      'multi-turn-feedback',
      'svg-gen',
      'plan-and-decompose',
      'clarification',
    ],
  },
  {
    id: 'repo-level',
    name: 'Repo-level work',
    hint: 'Cross-file changes, feature landing, refactor sweeps',
    subtasks: [
      'feature-land',
      'cross-file-refactor',
      'repo-search',
      'build-fix',
    ],
  },
]

// Templates we ship. LLM-as-judge is the default executor for the demo;
// code-executor is documented but the runtime is out of scope (G7 gap).
const TEMPLATES = {
  fixed: {
    id: 'fixed',
    name: 'Fixed checklist',
    hint: 'Same items for every task in this group (e.g. Bug fix: 5 items).',
  },
  'per-prompt': {
    id: 'per-prompt',
    name: 'Per-prompt dynamic',
    hint: 'Judge model composes a checklist for THIS prompt before scoring.',
  },
  'multi-turn': {
    id: 'multi-turn',
    name: 'Multi-turn (5 dims)',
    hint: 'Feedback-understanding · fix-effectiveness · no-regression · over-correction · convergence.',
  },
  'code-review': {
    id: 'code-review',
    name: 'Code review',
    hint: 'Reviewer rubric — style + correctness + tests.',
  },
}

// The 5 fixed multi-turn dimensions. Locked names match the RL plan and G16.
// Every dim carries a type spec — the LangSmith FeedbackSchema primitive
// (Continuous · Categorical · Boolean) that the annotation-panel dispatches
// on to pick the right scoring control. The 5 legacy dims stay continuous
// with min=1/max=5 so existing 1–5 button rows and stored records continue
// to round-trip unchanged (see also normalizeDimSpec / clampDimValue below).
const MULTI_TURN_DIMENSIONS = [
  { id: 'feedback-understanding', label: 'Feedback understanding',
    type: 'continuous', min: 1, max: 5,
    hint: 'Did the model correctly parse what the user asked for this turn?' },
  { id: 'fix-effectiveness', label: 'Fix effectiveness',
    type: 'continuous', min: 1, max: 5,
    hint: 'Did the response actually address the previous feedback?' },
  { id: 'no-regression', label: 'No regression',
    type: 'continuous', min: 1, max: 5,
    hint: 'Did previously-good behavior stay intact?' },
  { id: 'over-correction', label: 'Over-correction',
    type: 'continuous', min: 1, max: 5,
    hint: 'Did the model change more than the feedback asked for?' },
  { id: 'convergence', label: 'Convergence',
    type: 'continuous', min: 1, max: 5,
    hint: 'Is the turn moving toward or away from a stable answer?' },
]

// Primitive dimension types — LangSmith FeedbackSchema.Type parity. Each
// entry is the canonical spec for that primitive; render helpers key off
// `id` so the UI stays declarative. `defaultMin/defaultMax` capture what
// the LangSmith Create-feedback form pre-fills when the researcher picks
// the type — mirrored so our Create-from-scratch form reads the same way.
const DIMENSION_TYPES = [
  {
    id: 'continuous',
    label: 'Continuous',
    hint: 'Numeric score in [min, max]. Renders as a button row (small ranges) or a numeric input (large ranges).',
    defaultMin: 0,
    defaultMax: 1,
  },
  {
    id: 'categorical',
    label: 'Categorical',
    hint: 'One of a fixed enum (e.g. bad · ok · good). Renders as a button group; export keeps the enum text, not an index.',
    defaultValues: ['bad', 'ok', 'good'],
  },
  {
    id: 'boolean',
    label: 'Boolean',
    hint: 'Two-state toggle (pass · fail / true · false). Renders as a two-button switch.',
    defaultLabels: { true: 'true', false: 'false' },
  },
]

// Canonicalize a dim spec — fill in missing type defaults, coerce bad
// min/max to a safe continuous range, ensure categorical has non-empty
// values. Never mutates the input.
function normalizeDimSpec(dim) {
  if (!dim || typeof dim !== 'object') return null
  const type = (dim.type || 'continuous').toLowerCase()
  if (type === 'categorical') {
    const raw = Array.isArray(dim.values) && dim.values.length
      ? dim.values : ['bad', 'ok', 'good']
    const values = raw.map(v => String(v)).filter(Boolean)
    return {
      id: String(dim.id || 'unnamed'),
      label: String(dim.label || dim.id || 'unnamed'),
      type: 'categorical',
      values: values.length ? values : ['bad', 'ok', 'good'],
      hint: dim.hint || '',
    }
  }
  if (type === 'boolean') {
    return {
      id: String(dim.id || 'unnamed'),
      label: String(dim.label || dim.id || 'unnamed'),
      type: 'boolean',
      labels: (dim.labels && typeof dim.labels === 'object')
        ? { true: String(dim.labels.true || 'true'), false: String(dim.labels.false || 'false') }
        : { true: 'true', false: 'false' },
      hint: dim.hint || '',
    }
  }
  // continuous — coerce min/max to finite numbers, ensure min < max.
  let min = Number.isFinite(Number(dim.min)) ? Number(dim.min) : 0
  let max = Number.isFinite(Number(dim.max)) ? Number(dim.max) : 1
  if (min === max) max = min + 1
  if (min > max) { const t = min; min = max; max = t }
  return {
    id: String(dim.id || 'unnamed'),
    label: String(dim.label || dim.id || 'unnamed'),
    type: 'continuous',
    min, max,
    hint: dim.hint || '',
  }
}

// Coerce a raw user input for a dim into the stored value. Returns
// `undefined` when the input can't be represented — callers should treat
// that as "clear this dim". Continuous with small integer range keeps
// integers (button-row semantics); categorical returns the exact enum
// value; boolean returns strict true/false.
function clampDimValue(dim, raw) {
  const spec = normalizeDimSpec(dim)
  if (!spec) return undefined
  if (raw == null) return undefined
  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true' || raw === 1) return true
    if (raw === 'false' || raw === 0) return false
    return undefined
  }
  if (spec.type === 'categorical') {
    const v = String(raw)
    return spec.values.includes(v) ? v : undefined
  }
  // continuous
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  let clamped = n
  if (clamped < spec.min) clamped = spec.min
  if (clamped > spec.max) clamped = spec.max
  // Integer-valued ranges with span ≥ 2 (like the legacy 1–5 case) round
  // to int so stored records match the "button row" grammar and existing
  // tests. A 0–1 range span=1 is left as a float — that's LangSmith's
  // default continuous shape, which is a real-valued 0–1 probability.
  const integerRange = Number.isInteger(spec.min) && Number.isInteger(spec.max)
    && (spec.max - spec.min) >= 2 && (spec.max - spec.min) <= 10
  return integerRange ? Math.round(clamped) : clamped
}

// Normalize a raw value read back from storage (for export/read paths).
// Unlike clampDimValue this preserves stored numerics without re-rounding
// and returns `undefined` for values that don't match the spec — used by
// exporters that want to keep every scored dim intact.
function readDimValue(dim, raw) {
  const spec = normalizeDimSpec(dim)
  if (!spec) return undefined
  if (raw == null) return undefined
  if (spec.type === 'boolean') return typeof raw === 'boolean' ? raw : undefined
  if (spec.type === 'categorical') {
    const v = String(raw)
    return spec.values.includes(v) ? v : undefined
  }
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

// Compute a 0–1 normalized reward for a dim value. Continuous scales by
// (min, max); categorical maps to evenly-spaced positions; boolean → 1/0.
// Returns null when the value is missing or the spec can't be normalized.
// Used by projectTripleRows to fold typed dims into a single reward number.
function normalizeReward(dim, raw) {
  const spec = normalizeDimSpec(dim)
  if (!spec) return null
  const v = readDimValue(spec, raw)
  if (v === undefined) return null
  if (spec.type === 'boolean') return v ? 1 : 0
  if (spec.type === 'categorical') {
    const idx = spec.values.indexOf(String(v))
    if (idx < 0) return null
    if (spec.values.length === 1) return 1
    return Math.round((idx / (spec.values.length - 1)) * 1000) / 1000
  }
  // continuous
  const span = spec.max - spec.min
  if (span <= 0) return null
  return Math.round(((v - spec.min) / span) * 1000) / 1000
}

// Parse a `## Dimensions` block out of a rubric SKILL.md body. Each line
// is `- <id> :: <type> [ :: <arg1> [ :: <arg2> ]]` where <arg*> depends
// on type — continuous carries `min-max` (e.g. `1-5`), categorical
// carries a `,`-joined enum (e.g. `bad,ok,good`), boolean carries an
// optional `true/false` label pair (e.g. `pass/fail`). Callers get a
// normalized-spec array; unknown lines drop silently so old rubrics that
// still write freeform Notes here aren't broken. Kept lenient on
// purpose — the rubric library is user-authored and we would rather
// swallow a typo than fail to open the drawer.
function parseDimensionsBlock(body) {
  const out = []
  if (!body || typeof body !== 'string') return out
  let inDims = false
  for (const line of body.split('\n')) {
    if (/^##\s+Dimensions/i.test(line)) { inDims = true; continue }
    if (/^##\s+/.test(line)) { inDims = false; continue }
    if (!inDims) continue
    const m = /^\s*[-*]\s+(.+)$/.exec(line)
    if (!m) continue
    const parts = m[1].split('::').map(s => s.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const [id, typeRaw, arg1, arg2] = parts
    const type = typeRaw.toLowerCase()
    if (type === 'continuous') {
      const range = arg1 || ''
      const dash = range.split(/[-–—]/).map(s => Number(s.trim()))
      const min = Number.isFinite(dash[0]) ? dash[0] : 0
      const max = Number.isFinite(dash[1]) ? dash[1] : 1
      const spec = normalizeDimSpec({ id, label: arg2 || id, type: 'continuous', min, max })
      if (spec) out.push(spec)
    } else if (type === 'categorical') {
      const values = (arg1 || '').split(',').map(s => s.trim()).filter(Boolean)
      const spec = normalizeDimSpec({ id, label: arg2 || id, type: 'categorical', values })
      if (spec) out.push(spec)
    } else if (type === 'boolean') {
      const labels = (arg1 || '').split('/').map(s => s.trim()).filter(Boolean)
      const spec = normalizeDimSpec({
        id, label: arg2 || id, type: 'boolean',
        labels: labels.length >= 2 ? { true: labels[0], false: labels[1] } : undefined,
      })
      if (spec) out.push(spec)
    }
  }
  return out
}

// Resolve which dimensions to render for a rubric. Explicit `dimensions`
// on the rubric wins; otherwise multi-turn template falls back to the 5
// fixed dims; otherwise a rubric with a checklist has no dims (checklist
// is rendered as-is by the LLM judge). Returns a list of normalized dim
// specs so callers can render without re-normalizing.
function dimensionsForRubric(rubric) {
  if (!rubric || typeof rubric !== 'object') return []
  if (Array.isArray(rubric.dimensions) && rubric.dimensions.length) {
    return rubric.dimensions.map(normalizeDimSpec).filter(Boolean)
  }
  if (rubric.template === 'multi-turn') {
    return MULTI_TURN_DIMENSIONS.map(normalizeDimSpec).filter(Boolean)
  }
  return []
}

// Parse a SKILL.md-shaped rubric text into a structured record. Frontmatter
// is minimal — key: value on each line between `---` markers. Body is the
// checklist as a bullet list, plus optional `## Notes`.
function parseRubricFile(text) {
  if (typeof text !== 'string' || !text.length) return null
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const meta = {}
  if (lines[0] && lines[0].trim() === '---') {
    i = 1
    while (i < lines.length && lines[i].trim() !== '---') {
      const line = lines[i]
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
      if (m) meta[m[1]] = m[2].trim()
      i++
    }
    if (lines[i] && lines[i].trim() === '---') i++
  }
  const body = lines.slice(i).join('\n')
  const checklist = []
  const bulletRe = /^\s*[-*]\s+(.+)$/
  let inChecklist = false
  for (const line of body.split('\n')) {
    if (/^##\s+Checklist/i.test(line)) { inChecklist = true; continue }
    if (/^##\s+/.test(line)) { inChecklist = false; continue }
    if (inChecklist) {
      const m = bulletRe.exec(line)
      if (m) checklist.push(m[1].trim())
    }
  }
  const dimensions = parseDimensionsBlock(body)
  return {
    id: meta.name || 'unnamed',
    name: meta.name || 'unnamed',
    group: meta.group || 'code-gen',
    template: meta.template || 'fixed',
    executor: meta.executor || 'llm-judge',
    version: meta.version || 'v1',
    description: meta.description || '',
    checklist,
    dimensions,
    raw: text,
  }
}

// Build a catalog projection = ordered groups, each with the rubrics keyed
// to that group. Rubrics without a matching group land in a synthetic
// "uncategorized" bucket at the end so nothing silently drops.
function buildCatalog(rubrics) {
  const byGroup = new Map()
  for (const cat of TASK_CATEGORIES) {
    byGroup.set(cat.id, { category: cat, rubrics: [] })
  }
  const orphans = { category: {
    id: 'uncategorized',
    name: 'Uncategorized',
    hint: 'Rubrics whose group did not match any known category.',
    subtasks: [],
  }, rubrics: [] }
  for (const r of Array.isArray(rubrics) ? rubrics : []) {
    if (!r || typeof r !== 'object') continue
    const bucket = byGroup.get(r.group)
    if (bucket) bucket.rubrics.push(r)
    else orphans.rubrics.push(r)
  }
  const out = []
  for (const cat of TASK_CATEGORIES) out.push(byGroup.get(cat.id))
  if (orphans.rubrics.length) out.push(orphans)
  return out
}

// Compact preview text — first 3 checklist items joined by "·". Used on the
// row L0 so the user reads what the rubric checks without expanding.
function checklistPreview(rubric, max = 3) {
  const items = Array.isArray(rubric && rubric.checklist) ? rubric.checklist : []
  const head = items.slice(0, max)
  return head.join(' · ')
}

// Given a group id, return the display record (name + hint + subtasks).
function getCategory(groupId) {
  for (const cat of TASK_CATEGORIES) if (cat.id === groupId) return cat
  return null
}

// The 28-subtask flat picker — one flat list of {group, subtask} used by
// the annotation UI's task-tag picker (a session gets one primary tag).
function flatSubtaskList() {
  const out = []
  for (const cat of TASK_CATEGORIES) {
    for (const sub of cat.subtasks) {
      out.push({ groupId: cat.id, groupName: cat.name, subtaskId: sub })
    }
  }
  return out
}

// Total subtask count — helps the annotation UI advertise "N task types".
function totalSubtaskCount() {
  return flatSubtaskList().length
}

const rubricsModelApi = {
  TASK_CATEGORIES,
  TEMPLATES,
  MULTI_TURN_DIMENSIONS,
  DIMENSION_TYPES,
  parseRubricFile,
  parseDimensionsBlock,
  buildCatalog,
  checklistPreview,
  getCategory,
  flatSubtaskList,
  totalSubtaskCount,
  normalizeDimSpec,
  clampDimValue,
  readDimValue,
  normalizeReward,
  dimensionsForRubric,
}

if (typeof module !== 'undefined' && module.exports) module.exports = rubricsModelApi
if (typeof window !== 'undefined') window.__dshRubricsModel = rubricsModelApi
