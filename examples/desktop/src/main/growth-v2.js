// Growth v2 storage — where `+ rubric` / `⚑ error` forms land.
//
// Design:
//   - Layout: `~/.dsh/growth/rubrics/<compactWindowId>.json` and
//     `~/.dsh/growth/errors/<compactWindowId>.json`. One file per compact
//     window keeps writes append-safe (rewrite whole file on submit, no
//     partial-write tearing across windows) and makes the demo-day story —
//     "one file per moment in the runtime's history" — legible on disk.
//   - Seed source: `fixtures/trace-samples/growth-three-stage.json`. The
//     main process resolves the fixture from repo root and returns it as
//     `compactWindows`; user-written rubrics/errors ride alongside as
//     `userWrites`. The renderer merges via growth-v2-model.js so tests can
//     drive the merge without disk.
//   - The dispatch says `~/.dsh/growth/…` — we honor that verbatim under
//     `os.homedir() + '/.dsh/growth/'`, distinct from the existing
//     `~/.dsh-desktop/growth-log.jsonl` (which is the runtime-shaping event
//     log, an unrelated surface).

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const HOME_ENV = 'DSH_GROWTH_HOME'

function growthHome() {
  return process.env[HOME_ENV] || path.join(os.homedir(), '.dsh', 'growth')
}

function rubricsPath(cwId) {
  return path.join(growthHome(), 'rubrics', `${sanitizeId(cwId)}.json`)
}

function errorsPath(cwId) {
  return path.join(growthHome(), 'errors', `${sanitizeId(cwId)}.json`)
}

function sanitizeId(id) {
  // Cw ids in the fixture are stable slugs (e.g. cw-2026-07-01); guard
  // against a bad payload turning into `../../etc/passwd`.
  const s = String(id || '').replace(/[^A-Za-z0-9._-]+/g, '_')
  return s || 'unknown'
}

function readJsonArr(p) {
  try {
    const text = fs.readFileSync(p, 'utf8')
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    console.debug(`growth-v2 read failed (${p}): ${err.message}`)
    return []
  }
}

function writeJsonArr(p, arr) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8')
}

// Discover the seed fixture. Repo layout: this file is at src/main/, fixture
// at fixtures/trace-samples/. If the fixture is missing we fall back to an
// empty-shell payload — a demo without seed data is still a valid demo.
function loadSeed() {
  const p = path.resolve(__dirname, '..', '..', 'fixtures', 'trace-samples', 'growth-three-stage.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    console.debug(`growth-v2 seed load failed: ${err.message}`)
    return { compactWindows: [] }
  }
}

// Read everything the Growth v2 page needs in one round trip: the seeded
// compact windows + every user-written rubric/error on disk, grouped by cw
// id so the projector can zip them together without touching the fs itself.
function readAll() {
  const seed = loadSeed()
  const wins = Array.isArray(seed.compactWindows) ? seed.compactWindows : []
  const userWrites = { rubrics: {}, errors: {} }
  for (const cw of wins) {
    if (!cw || !cw.id) continue
    const r = readJsonArr(rubricsPath(cw.id))
    const e = readJsonArr(errorsPath(cw.id))
    if (r.length) userWrites.rubrics[cw.id] = r
    if (e.length) userWrites.errors[cw.id] = e
  }
  return {
    compactWindows: wins,
    installedAt: seed.installedAt || null,
    logPath: growthHome(),
    userWrites,
    seedNote: seed._mockReason || null,
  }
}

// Append one rubric to the given compact window. Returns { ok, entry }.
// `entry.id` is auto-issued if the caller didn't provide one; `createdAt`
// stamps the server time so the wall-clock story is consistent regardless
// of the renderer's Date.now() drift.
function addRubric(cwId, form) {
  const arr = readJsonArr(rubricsPath(cwId))
  const entry = {
    id: (form && form.id) || `u-${Date.now().toString(36)}`,
    assertion: String((form && form.assertion) || '').trim(),
    expected: String((form && form.expected) || '').trim(),
    tag: (form && form.tag) ? String(form.tag).trim() : undefined,
    createdAt: Date.now(),
  }
  if (!entry.assertion) return { ok: false, reason: 'assertion-required' }
  arr.push(entry)
  writeJsonArr(rubricsPath(cwId), arr)
  return { ok: true, entry }
}

function addError(cwId, form) {
  const arr = readJsonArr(errorsPath(cwId))
  const entry = {
    id: (form && form.id) || `u-${Date.now().toString(36)}`,
    text: String((form && form.text) || '').trim(),
    cause: String((form && form.cause) || '').trim(),
    todo: (form && form.todo) ? String(form.todo).trim() : undefined,
    createdAt: Date.now(),
  }
  if (!entry.text) return { ok: false, reason: 'text-required' }
  arr.push(entry)
  writeJsonArr(errorsPath(cwId), arr)
  return { ok: true, entry }
}

module.exports = {
  growthHome,
  rubricsPath,
  errorsPath,
  readAll,
  addRubric,
  addError,
  loadSeed,
}
