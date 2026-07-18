// Hub page — main-process file IO + script runner.
//
// The Hub is the extensibility-first asset catalog: seven kinds of file-backed
// artefacts that a researcher edits, forks, and hands to a runtime. All state
// for the demo tier lives under `<runtimeDir>/hub/<kind>/<name>.<ext>`, one
// file per row. Editing a row rewrites the file after saving the prior
// contents to `<name>.<ext>.<ISOtimestamp>.bak` so the "version history" chip
// can show a sensible list without a real VCS in the loop.
//
// This is the demo tier of SDK gaps G1 (library/list|get|put) and G11
// (dataset/list|get|put|version); the upstream wire method would replace the
// fs walk with a server call and keep the same row shape. See
// docs/design-refs/ia-design-pack-179.md § Library and
// docs/design-refs/rl-workflow-needs.md §3.
//
// Script execution reuses the isolated-daemon *idea* — a cwd-jailed child
// with a narrowed env — but does it directly with `child_process.spawn`
// because a script isn't an agent. The user is running scripts they wrote;
// see the honest security note in the UI ("researcher-authored scripts only").

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')

// Root of the on-disk Hub asset store. Kept under a `.dsh-demo-assets` folder
// inside the shell's runtime dir so the demo can be blown away without
// touching the real `.dsh` overlay. The wire tier would move this to
// `~/.dsh/{library,datasets,scripts}`.
function hubRoot(runtimeDir) {
  return path.join(runtimeDir, 'hub')
}

// The seven kinds and their default file extensions. Kept in sync with
// hub-model.js KIND_META. This list is exported so tests can iterate it.
const KIND_EXT = Object.freeze({
  plugin:  'yaml',
  skill:   'md',
  prompt:  'md',
  rubric:  'yaml',
  profile: 'yaml',
  dataset: 'jsonl',
  script:  'py',
})

// Guard against directory-escape via a crafted name. Names must be a
// single path segment of safe characters; anything else rejects. This is
// belt-and-suspenders since main is trusted, but the demo lets users type
// names in prompts so a stray '..' is a real footgun.
function isSafeName(name) {
  return typeof name === 'string' &&
    /^[A-Za-z0-9._-]{1,120}$/.test(name) &&
    name !== '.' && name !== '..'
}

function ensureRootDirs(runtimeDir) {
  const root = hubRoot(runtimeDir)
  fs.mkdirSync(root, { recursive: true })
  for (const kind of Object.keys(KIND_EXT)) {
    fs.mkdirSync(path.join(root, kind + 's'), { recursive: true })
  }
  return root
}

// Kind directory. Pluralised so the on-disk tree reads naturally:
// `.dsh-demo-assets/hub/scripts/dedup_exact.py`.
function kindDir(runtimeDir, kind) {
  return path.join(hubRoot(runtimeDir), kind + 's')
}

// List one kind's rows by walking its directory. Datasets get their row
// count computed here (cheap for demo-sized JSONL). Scripts get language +
// last-run derived from the script's own extension + a sibling `.last.json`
// file the runner writes on completion.
function listKind(runtimeDir, kind) {
  ensureRootDirs(runtimeDir)
  const dir = kindDir(runtimeDir, kind)
  let entries
  try { entries = fs.readdirSync(dir) } catch (_) { entries = [] }
  const rows = []
  for (const entry of entries) {
    if (entry.endsWith('.bak') || entry.endsWith('.last.json')) continue
    if (entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    let stat
    try { stat = fs.statSync(full) } catch (_) { continue }
    if (!stat.isFile()) continue
    const parsed = path.parse(entry)
    const row = {
      kind,
      name: parsed.name,
      version: 'v1',                 // one file per name; version chip is demo-only
      path: full,
      description: '',
      versions: listVersions(full),  // .bak siblings
    }
    if (kind === 'dataset') {
      row.rowCount = safeCountJsonl(full)
    }
    if (kind === 'script') {
      row.lang = detectLang(parsed.ext)
      const meta = readLastRun(full)
      if (meta) {
        row.lastRun = meta.finishedAt
        row.lastStatus = meta.status
      }
    }
    rows.push(row)
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

// List all kinds as one flat array. Callers usually re-sort via hub-model's
// sortHubRows for the header ordering; we return them in kind-order too so
// consumers that don't want to reprocess still get a sensible list.
function listAll(runtimeDir) {
  const out = []
  for (const kind of Object.keys(KIND_EXT)) {
    for (const row of listKind(runtimeDir, kind)) out.push(row)
  }
  return out
}

// Read one asset's raw text. Rejects if the target isn't inside the kind's
// dir (defence in depth against a name-based escape).
function readAsset(runtimeDir, kind, name) {
  if (!KIND_EXT[kind]) throw new Error(`unknown kind: ${kind}`)
  if (!isSafeName(name)) throw new Error(`unsafe name: ${name}`)
  const p = resolveAssetPath(runtimeDir, kind, name)
  return fs.readFileSync(p, 'utf8')
}

// Write one asset's raw text. Backs up the previous contents to a
// `.bak.<isotime>` sibling before overwriting. Callers see this as the
// "Save as v{n+1}" chip. New files skip the backup.
function writeAsset(runtimeDir, kind, name, body) {
  if (!KIND_EXT[kind]) throw new Error(`unknown kind: ${kind}`)
  if (!isSafeName(name)) throw new Error(`unsafe name: ${name}`)
  if (typeof body !== 'string') throw new Error('body must be a string')
  ensureRootDirs(runtimeDir)
  const p = resolveAssetPath(runtimeDir, kind, name)
  if (fs.existsSync(p)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bak = p + '.' + stamp + '.bak'
    fs.copyFileSync(p, bak)
  }
  fs.writeFileSync(p, body)
  return { path: p, versions: listVersions(p) }
}

// Return the version manifest for one asset: the current file's mtime as v1
// and each `.bak` sibling as a prior version. The wire tier would source
// this from the manifest yaml the server maintains.
function listVersions(assetPath) {
  const dir = path.dirname(assetPath)
  const base = path.basename(assetPath)
  const versions = []
  try {
    const stat = fs.statSync(assetPath)
    versions.push({ label: 'current', mtime: stat.mtime.toISOString(), path: assetPath })
  } catch (_) { /* file gone */ }
  let siblings
  try { siblings = fs.readdirSync(dir) } catch (_) { siblings = [] }
  for (const s of siblings) {
    if (!s.startsWith(base + '.') || !s.endsWith('.bak')) continue
    const full = path.join(dir, s)
    let stat
    try { stat = fs.statSync(full) } catch (_) { continue }
    // Strip the sentinel so the label reads as a plain timestamp.
    const label = s.slice(base.length + 1, -'.bak'.length)
    versions.push({ label, mtime: stat.mtime.toISOString(), path: full })
  }
  return versions
}

// Read one version's contents by path (must be inside the same kind dir as
// the asset). Used by the "view prior version" flow in the drawer.
function readVersion(runtimeDir, kind, versionPath) {
  if (!KIND_EXT[kind]) throw new Error(`unknown kind: ${kind}`)
  const kd = kindDir(runtimeDir, kind)
  const resolved = path.resolve(versionPath)
  if (!resolved.startsWith(kd + path.sep) && resolved !== kd) {
    throw new Error(`version path outside kind dir: ${versionPath}`)
  }
  return fs.readFileSync(resolved, 'utf8')
}

function resolveAssetPath(runtimeDir, kind, name) {
  const dir = kindDir(runtimeDir, kind)
  const ext = KIND_EXT[kind]
  // If the caller included their own extension, respect it (scripts can be
  // .js or .sh, datasets are always .jsonl); otherwise pin the kind default.
  const looksExtd = /\.[A-Za-z0-9]{1,6}$/.test(name)
  return path.join(dir, looksExtd ? name : `${name}.${ext}`)
}

function detectLang(ext) {
  const e = ext.toLowerCase()
  if (e === '.py') return 'python'
  if (e === '.js') return 'node'
  if (e === '.mjs') return 'node'
  if (e === '.sh') return 'shell'
  if (e === '.bash') return 'shell'
  return 'python'
}

function safeCountJsonl(p) {
  try {
    const text = fs.readFileSync(p, 'utf8')
    let n = 0
    for (const line of text.split(/\r?\n/)) { if (line.trim()) n++ }
    return n
  } catch (_) { return null }
}

function readLastRun(scriptPath) {
  const meta = scriptPath + '.last.json'
  try {
    return JSON.parse(fs.readFileSync(meta, 'utf8'))
  } catch (_) { return null }
}

function writeLastRun(scriptPath, entry) {
  try {
    fs.writeFileSync(scriptPath + '.last.json', JSON.stringify(entry, null, 2))
  } catch (_) { /* best effort */ }
}

// -- Script runner --------------------------------------------------------

// The runner spawns the interpreter matching the script's language, hands it
// the input file (JSONL) as argv[1] and the output file (JSONL) as argv[2],
// and streams stdout/stderr chunks to the caller. On close, if the process
// exited 0 and produced a JSON summary line, we write a `.last.json` sibling
// beside the script so the next hub list shows lastRun + lastStatus.
//
// Trust boundary — see the doc comment at the top of this file. The child
// runs in a per-run temp cwd; the env is narrowed to the demo's allowlist
// plus DEEPSEEK_API_KEY if the shell has one so scripts can call the model
// from the same key the agent uses.
const runners = new Map() // runId -> { child, kill }

const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'SHELL',
  'DEEPSEEK_API_KEY', 'DSH_DEMO_HUB', // last one is our own marker
]

function narrowEnv(rawEnv) {
  const out = {}
  for (const k of ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(rawEnv, k) && rawEnv[k] !== undefined) {
      out[k] = rawEnv[k]
    }
  }
  out.DSH_DEMO_HUB = '1'
  return out
}

function interpreterFor(lang) {
  if (lang === 'python') return { cmd: 'python3', args: [] }
  if (lang === 'node')   return { cmd: 'node',    args: [] }
  if (lang === 'shell')  return { cmd: 'bash',    args: [] }
  throw new Error(`unsupported script language: ${lang}`)
}

// Run a script. `input` is one of:
//   { kind: 'file', path }         — pass path as-is to the child
//   { kind: 'dataset', name }      — resolve to the dataset's on-disk path
//   { kind: 'inline', body }       — write body to a temp file first
// The output is always written by the child to argv[2]; we then hand back
// the output path so the caller can promote it to a dataset row. `on` is a
// per-run callback fired with `{stream:'stdout'|'stderr', chunk}` (partial
// utf-8 chunks) and a final `{stream:'exit', code, signal, summary}`.
function runScript(runtimeDir, { scriptPath, lang, input, on }) {
  ensureRootDirs(runtimeDir)
  const resolvedLang = lang || detectLang(path.extname(scriptPath))
  const { cmd, args: baseArgs } = interpreterFor(resolvedLang)
  const runId = crypto.randomBytes(6).toString('hex')
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-hub-run-${runId}-`))
  const inputPath = resolveRunInput(runtimeDir, runDir, input)
  const outputPath = path.join(runDir, 'output.jsonl')
  const argv = [...baseArgs, scriptPath, inputPath, outputPath]
  let child
  try {
    child = spawn(cmd, argv, {
      cwd: runDir,
      env: narrowEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    on && on({ stream: 'exit', code: -1, signal: null, error: err.message })
    return { runId, kill: () => {} }
  }
  const stdoutBufs = []
  const stderrBufs = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBufs.push(chunk)
    on && on({ stream: 'stdout', chunk })
  })
  child.stderr.on('data', (chunk) => {
    stderrBufs.push(chunk)
    on && on({ stream: 'stderr', chunk })
  })
  child.on('error', (err) => {
    on && on({ stream: 'stderr', chunk: `spawn error: ${err.message}\n` })
  })
  child.on('close', (code, signal) => {
    runners.delete(runId)
    const stdout = stdoutBufs.join('')
    const stderr = stderrBufs.join('')
    let summary = parseStdoutSummary(stdout)
    let outputRows = null
    try { outputRows = safeCountJsonl(outputPath) } catch (_) { /* absent */ }
    // If the script emitted no summary, derive one from the row-count delta
    // so the caller still gets an honest before/after chip.
    if (!summary) {
      const inputRows = safeCountJsonl(inputPath)
      summary = {
        written: outputRows,
        dropped: (Number.isFinite(inputRows) && Number.isFinite(outputRows))
          ? inputRows - outputRows : null,
        notes: 'no summary emitted',
        source: 'derived',
      }
    }
    writeLastRun(scriptPath, {
      finishedAt: new Date().toISOString(),
      status: code === 0 ? 'ok' : 'error',
      code, signal,
      summary,
      inputPath, outputPath,
    })
    on && on({
      stream: 'exit', code, signal,
      summary, stdout, stderr,
      inputPath, outputPath, outputRows,
    })
  })
  const kill = () => {
    try { child.kill('SIGTERM') } catch (_) { /* already gone */ }
  }
  runners.set(runId, { child, kill })
  return { runId, kill, inputPath, outputPath, runDir }
}

// Cancel a running script by id.
function cancelRun(runId) {
  const r = runners.get(runId)
  if (!r) return false
  r.kill()
  return true
}

function resolveRunInput(runtimeDir, runDir, input) {
  if (!input || typeof input !== 'object') {
    // No input — hand the script a blank file so it doesn't blow up on argv[1]
    const blank = path.join(runDir, 'input.jsonl')
    fs.writeFileSync(blank, '')
    return blank
  }
  if (input.kind === 'file') {
    if (typeof input.path !== 'string' || !fs.existsSync(input.path)) {
      throw new Error(`input file not found: ${input.path}`)
    }
    return input.path
  }
  if (input.kind === 'dataset') {
    if (!isSafeName(input.name)) throw new Error(`unsafe dataset name: ${input.name}`)
    return resolveAssetPath(runtimeDir, 'dataset', input.name)
  }
  if (input.kind === 'inline') {
    const p = path.join(runDir, 'input.jsonl')
    fs.writeFileSync(p, String(input.body || ''))
    return p
  }
  throw new Error(`unknown input kind: ${input.kind}`)
}

// Same last-line-JSON parser as the renderer's hub-model.parseScriptSummary,
// duplicated here because main is a different runtime and we don't want the
// preload path to have to reach into src/renderer/*.js. Keep the two in step
// (tests lock both).
function parseStdoutSummary(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null
  const lines = stdout.trimEnd().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || line[0] !== '{') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') {
        const written = Number.isFinite(parsed.written) ? parsed.written : null
        const dropped = Number.isFinite(parsed.dropped) ? parsed.dropped : null
        const notes = typeof parsed.notes === 'string' ? parsed.notes : ''
        if (written !== null || dropped !== null) {
          return { written, dropped, notes, source: 'stdout' }
        }
      }
    } catch (_) { /* try earlier */ }
  }
  return null
}

// Seed the hub with a starter set of sample assets so the demo has content
// to show on first launch. Idempotent — never overwrites existing files.
// The samples cover every kind so the section-count chips read as non-zero
// and the researcher can click through each L1 preview.
function seedSamples(runtimeDir, samplesDir) {
  ensureRootDirs(runtimeDir)
  if (!fs.existsSync(samplesDir)) return { copied: 0 }
  let copied = 0
  for (const kind of Object.keys(KIND_EXT)) {
    const srcDir = path.join(samplesDir, kind + 's')
    if (!fs.existsSync(srcDir)) continue
    const dstDir = kindDir(runtimeDir, kind)
    for (const entry of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, entry)
      const dst = path.join(dstDir, entry)
      if (fs.existsSync(dst)) continue
      const stat = fs.statSync(src)
      if (!stat.isFile()) continue
      fs.copyFileSync(src, dst)
      copied++
    }
  }
  return { copied }
}

module.exports = {
  KIND_EXT,
  isSafeName,
  hubRoot,
  kindDir,
  ensureRootDirs,
  listKind,
  listAll,
  readAsset,
  writeAsset,
  listVersions,
  readVersion,
  runScript,
  cancelRun,
  seedSamples,
  parseStdoutSummary,
  // Test seams
  narrowEnv,
  ENV_ALLOWLIST,
}
