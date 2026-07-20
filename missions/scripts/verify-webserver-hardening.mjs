// Webserver hardening probe (audit R1): malformed requests must yield 4xx/5xx, never kill
// the process. Prereq: dsh web on 3080. Run: node missions/scripts/verify-webserver-hardening.mjs
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
let failures = 0

function report(name, pass, detail = '') {
  failures += pass ? 0 : 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function status(path, init) {
  try {
    return (await fetch(`${BASE}${path}`, init)).status
  } catch {
    return 0 // connection refused/reset — the server died or dropped us
  }
}

// R1 trigger set: bad %-encodings (decodeURIComponent URIError), long path, bad method, non-JSON API body.
const cases = [
  ['/%', [400]],
  ['/%c0', [400]],
  ['/%zz%', [400]],
  ['/' + 'a'.repeat(9000), [200]], // SPA fallback, must not throw
  ['/foo', [405], { method: 'DELETE' }],
  ['/api/session.list', [400], { method: 'POST', body: 'not json' }],
]
for (const [path, expect, init] of cases) {
  const got = await status(path, init)
  const label = path.length > 24 ? `${path.slice(0, 24)}…` : path
  report(`${init?.method ?? 'GET'} ${label} -> ${expect.join('/')}`, expect.includes(got), `got=${got}`)
}

report('server alive after the barrage (GET / -> 200)', (await status('/')) === 200)

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
