#!/usr/bin/env node
/**
 * Gate v2 — in-process TS compiler API, no tsc subprocess.
 *
 * Checks the ESSENCE, not a proxy: which keys are merged onto cordis
 * `Context`/`Events` in a given program, and which file each one comes from.
 * A client program passes only if every contributing file is client-safe
 * (allowlisted); the closure check remains as a coarse secondary signal.
 *
 * Modes:
 *   node gate-api.mjs <tsconfig> [--expect-fail]     single-program audit
 *   node gate-api.mjs --diff <client-cfg> <node-cfg> two-sided parity report
 *
 * The key→origin table doubles as the parity input for the peer-Loader work:
 * diff mode prints keys exclusive to each side.
 */
import ts from 'typescript'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

/** Client-safe augmentation origins; every other contributor fails a client audit. */
const CLIENT_SAFE_ORIGINS = [
  /^vendor\/cordis\/src\//, // the base interfaces themselves
  /^vendor\/timer\/src\/index\.ts$/,
]

/** Parse a tsconfig into a ts.ParsedCommandLine (throws on config errors). */
function parseConfig(configPath) {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')) } }
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)
  if (!parsed) throw new Error(`cannot parse ${configPath}`)
  return parsed
}

/** Build the program and return { program, checker, repoFiles }. */
function buildProgram(configPath) {
  const parsed = parseConfig(configPath)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  const repoFiles = program.getSourceFiles()
    .map((sf) => resolve(sf.fileName))
    .filter((f) => f.startsWith(repoRoot) && !/\/node_modules\/(typescript|@types)\//.test(f))
    .map((f) => relative(repoRoot, f))
  return { program, checker: program.getTypeChecker(), repoFiles }
}

/**
 * Trace every member merged onto a cordis interface: key → contributing files.
 * Walks the interface SYMBOL's declarations, so it sees source-file interfaces,
 * `declare module 'cordis'` augmentations, and .d.ts-borne augmentations alike.
 */
function traceMergedKeys(program, checker, interfaceName) {
  const contributions = new Map() // key -> Set<originFile>
  const record = (key, file) => {
    if (!contributions.has(key)) contributions.set(key, new Set())
    contributions.get(key).add(relative(repoRoot, resolve(file)))
  }
  // Find the interface symbol via any declaration of it in the program: scan
  // source files for InterfaceDeclaration named `interfaceName` whose module
  // is cordis (base file under vendor/cordis) or an augmentation of 'cordis'.
  for (const sf of program.getSourceFiles()) {
    const visit = (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName && isCordisScope(node, sf)) {
        for (const member of node.members) {
          const key = memberKeyName(member)
          if (key !== undefined) record(key, sf.fileName)
          // Heritage clauses (e.g. `interface Context extends Pick<TimerService, ...>`)
          // contribute keys without member declarations; attribute them to this file.
        }
        for (const heritage of node.heritageClauses ?? []) {
          for (const t of heritage.types) record(`(extends ${t.getText(sf).slice(0, 60)})`, sf.fileName)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  void checker
  return contributions
}

/** True if this interface declaration merges into the cordis module scope. */
function isCordisScope(node, sf) {
  const fileName = resolve(sf.fileName)
  if (relative(repoRoot, fileName).startsWith('vendor/cordis/src/')) return true
  // Otherwise require an enclosing `declare module 'cordis'`.
  let cur = node.parent
  while (cur) {
    if (ts.isModuleDeclaration(cur) && ts.isStringLiteral(cur.name) && cur.name.text === 'cordis') return true
    cur = cur.parent
  }
  return false
}

/** Printable key for an interface member (property/method/index/computed). */
function memberKeyName(member) {
  const name = member.name
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`
  return name.getText()
}

/** Audit one program: returns { table, violations }. */
function audit(configPath) {
  const { program, checker, repoFiles } = buildProgram(configPath)
  const table = new Map()
  for (const iface of ['Context', 'Events']) {
    for (const [key, origins] of traceMergedKeys(program, checker, iface)) {
      table.set(`${iface}.${key}`, origins)
    }
  }
  const violations = []
  for (const [key, origins] of table) {
    for (const origin of origins) {
      if (!CLIENT_SAFE_ORIGINS.some((p) => p.test(origin))) {
        violations.push(`[merge] ${key} <- ${origin}`)
      }
    }
  }
  return { table, violations, repoFiles }
}

function printTable(label, table) {
  console.log(`\n${label}: ${table.size} merged keys`)
  const sorted = [...table.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [key, origins] of sorted) {
    console.log(`  ${key}  <-  ${[...origins].join(', ')}`)
  }
}

const args = process.argv.slice(2)
if (args[0] === '--diff') {
  const [clientCfg, nodeCfg] = [args[1], args[2]]
  const client = audit(clientCfg)
  const node = audit(nodeCfg)
  printTable(`client (${clientCfg})`, client.table)
  printTable(`node (${nodeCfg})`, node.table)
  const clientOnly = [...client.table.keys()].filter((k) => !node.table.has(k))
  const nodeOnly = [...node.table.keys()].filter((k) => !client.table.has(k))
  console.log('\n== parity report ==')
  console.log(`shared: ${[...client.table.keys()].filter((k) => node.table.has(k)).length}`)
  console.log(`client-only: ${clientOnly.join(', ') || '(none)'}`)
  console.log(`node-only: ${nodeOnly.join(', ') || '(none)'}`)
  process.exit(0)
}

const configPath = args[0]
const expectFail = args.includes('--expect-fail')
if (!configPath) {
  console.error('usage: gate-api.mjs <tsconfig> [--expect-fail] | --diff <client-cfg> <node-cfg>')
  process.exit(2)
}
const { table, violations, repoFiles } = audit(configPath)
console.log(`gate-api: ${configPath} — ${repoFiles.length} repo files, ${table.size} merged keys`)
printTable('merged-key table', table)
if (violations.length) {
  console.log('\nviolations:')
  for (const v of violations) console.log('  ' + v)
}
const failed = violations.length > 0
if (expectFail) {
  console.log(failed ? 'EXPECTED-FAIL: OK (gate caught it)' : 'EXPECTED-FAIL: MISSED — gate is blind!')
  process.exit(failed ? 0 : 1)
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
