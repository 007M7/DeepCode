// Artifact server unit tests. Runs under `node --test`, no Electron.
//
// Covers:
//   1. isArtifactPath / pathToArtifactId / artifactIdToPath / parseArtifactUrl
//      — pure path matching, including traversal defence.
//   2. preparePage — SSE snippet injection into a full doc, a fragment, and
//      a .md input.
//   3. ArtifactServer end-to-end:
//      - starts on a random 127.0.0.1 port
//      - initial scan picks up pre-existing files
//      - fs.watch picks up a new file (event fires)
//      - GET /a/<id>/ returns the page with the SSE snippet
//      - GET /events opens an SSE channel with the right headers, and a
//        subsequent artifact write broadcasts a reload event
//      - close() releases the port

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')

const {
  ArtifactServer,
  isArtifactPath,
  pathToArtifactId,
  artifactIdToPath,
  parseArtifactUrl,
  preparePage,
  ARTIFACT_EXTS,
} = require('../src/main/artifact-server.js')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifact-test-'))
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.setTimeout(2000, () => { req.destroy(new Error('http get timeout')); })
  })
}

// -- pure helpers ------------------------------------------------------------

test('isArtifactPath matches html/svg/md and rejects everything else', () => {
  assert.equal(isArtifactPath('foo.html'), true)
  assert.equal(isArtifactPath('foo.HTML'), true)
  assert.equal(isArtifactPath('/tmp/a/b/c.svg'), true)
  assert.equal(isArtifactPath('report.md'), true)
  assert.equal(isArtifactPath('foo.txt'), false)
  assert.equal(isArtifactPath('foo'), false)
  assert.equal(isArtifactPath(''), false)
  assert.equal(isArtifactPath(null), false)
  assert.equal(isArtifactPath(undefined), false)
  assert.equal(isArtifactPath(42), false)
  // Extensions we deliberately don't count: .htm, .xml, .txt.
  assert.equal(isArtifactPath('foo.htm'), false)
})

test('pathToArtifactId returns null for paths outside the artifact dir', () => {
  const dir = '/workspace/.artifacts'
  assert.equal(pathToArtifactId('/workspace/.artifacts/report.html', dir), 'report.html')
  assert.equal(pathToArtifactId('/workspace/.artifacts/sub/dir/a.html', dir), 'sub/dir/a.html')
  assert.equal(pathToArtifactId('/workspace/other/report.html', dir), null)
  assert.equal(pathToArtifactId('/etc/passwd', dir), null)
  // The dir itself is not an artifact.
  assert.equal(pathToArtifactId('/workspace/.artifacts', dir), null)
})

test('artifactIdToPath rejects traversal / absolute ids', () => {
  const dir = '/workspace/.artifacts'
  assert.equal(artifactIdToPath('report.html', dir), '/workspace/.artifacts/report.html')
  assert.equal(artifactIdToPath('sub/dir/a.html', dir), '/workspace/.artifacts/sub/dir/a.html')
  assert.equal(artifactIdToPath('../../etc/passwd', dir), null)
  assert.equal(artifactIdToPath('/etc/passwd', dir), null)
  assert.equal(artifactIdToPath('', dir), null)
  assert.equal(artifactIdToPath(null, dir), null)
  // URL-encoded traversal is also blocked.
  assert.equal(artifactIdToPath('..%2F..%2Fetc%2Fpasswd', dir), null)
})

test('parseArtifactUrl extracts nested ids and rejects everything else', () => {
  assert.equal(parseArtifactUrl('/a/report.html/'), 'report.html')
  assert.equal(parseArtifactUrl('/a/report.html'), 'report.html')
  assert.equal(parseArtifactUrl('/a/sub/dir/a.html/'), 'sub/dir/a.html')
  assert.equal(parseArtifactUrl('/a/report.html?v=3'), 'report.html')
  assert.equal(parseArtifactUrl('/'), null)
  assert.equal(parseArtifactUrl('/events'), null)
  assert.equal(parseArtifactUrl('/a/'), null)
  assert.equal(parseArtifactUrl(''), null)
})

test('preparePage injects the SSE snippet into a full document before </body>', () => {
  const src = '<!doctype html><html><head></head><body><h1>hi</h1></body></html>'
  const out = preparePage(src, '.html')
  assert.match(out, /new EventSource\('\/events'\)/)
  // Snippet must appear before </body>, not after.
  const sseIdx = out.indexOf("new EventSource('/events')")
  const bodyIdx = out.indexOf('</body>')
  assert.ok(sseIdx > 0 && sseIdx < bodyIdx, 'SSE snippet must appear before </body>')
})

test('preparePage wraps a bare-fragment .html input in a skeleton', () => {
  const out = preparePage('<h1>hi</h1>', '.html')
  assert.match(out, /^<!doctype html/i)
  assert.match(out, /<h1>hi<\/h1>/)
  assert.match(out, /new EventSource/)
})

test('preparePage renders .md as an escaped <pre> and injects the snippet', () => {
  const out = preparePage('# hi\n<script>alert(1)</script>', '.md')
  assert.match(out, /&lt;script&gt;/)   // escaped, not literal
  assert.doesNotMatch(out, /<script>alert\(1\)<\/script>/)
  assert.match(out, /new EventSource/)
})

test('preparePage passes .svg through untouched (served with the svg MIME)', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
  assert.equal(preparePage(svg, '.svg'), svg)
})

test('ARTIFACT_EXTS is the source of truth', () => {
  assert.deepEqual([...ARTIFACT_EXTS].sort(), ['.html', '.md', '.svg'])
})

// -- server integration ------------------------------------------------------

test('ArtifactServer starts on 127.0.0.1 with an ephemeral port', async () => {
  const dir = tmpDir()
  const s = new ArtifactServer({ artifactDir: dir })
  try {
    await s.ensureStarted()
    assert.ok(s.port > 0)
    assert.equal(s.host, '127.0.0.1')
    assert.match(s.baseUrl(), /^http:\/\/127\.0\.0\.1:\d+$/)
    // /health responds with a JSON payload.
    const r = await get(s.baseUrl() + '/health')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /application\/json/)
    assert.match(r.body, /"ok":true/)
  } finally {
    await s.close()
  }
})

test('ArtifactServer serves an existing HTML file with the SSE snippet injected', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'report.html'), '<!doctype html><html><body><h1>hello</h1></body></html>')
  const s = new ArtifactServer({ artifactDir: dir })
  try {
    await s.ensureStarted()
    // The initial scan populates knownArtifacts.
    assert.ok(s.knownArtifacts.has('report.html'), 'initial scan should register the file')
    const r = await get(s.urlFor('report.html'))
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /text\/html/)
    assert.match(r.body, /<h1>hello<\/h1>/)
    assert.match(r.body, /new EventSource\('\/events'\)/)
    // No-store cache header so live reload always fetches fresh.
    assert.match(r.headers['cache-control'] || '', /no-store/)
  } finally {
    await s.close()
  }
})

test('ArtifactServer rejects traversal / non-existent artifact ids', async () => {
  const dir = tmpDir()
  const s = new ArtifactServer({ artifactDir: dir })
  try {
    await s.ensureStarted()
    const bad = await get(s.baseUrl() + '/a/..%2F..%2Fetc%2Fpasswd/')
    assert.equal(bad.status, 400)
    const missing = await get(s.baseUrl() + '/a/nope.html/')
    assert.equal(missing.status, 404)
    const junk = await get(s.baseUrl() + '/nope')
    assert.equal(junk.status, 404)
  } finally {
    await s.close()
  }
})

test('SSE /events opens the right headers and broadcasts reload on artifact update', async () => {
  const dir = tmpDir()
  const s = new ArtifactServer({ artifactDir: dir })
  try {
    await s.ensureStarted()
    // Open an SSE connection manually so we can read the raw stream.
    const url = new URL(s.baseUrl() + '/events')
    const chunks = []
    const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname })
    const resPromise = new Promise((resolve) => req.on('response', resolve))
    const res = await resPromise
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    assert.match(res.headers['cache-control'] || '', /no-store/)
    res.on('data', (c) => chunks.push(c.toString('utf8')))

    // Wait a beat for the SSE handshake payload (`retry: 300`) and for the
    // server to register our connection.
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(s.clients.size >= 1, 'server should have registered the SSE client')

    // Poking the server directly to sidestep fs.watch flakiness under CI.
    const abs = path.join(dir, 'live.html')
    fs.writeFileSync(abs, '<!doctype html><html><body>v1</body></html>')
    s._noteArtifact(abs, 'test')

    // Give the broadcast a moment.
    await new Promise((r) => setTimeout(r, 30))
    const raw = chunks.join('')
    assert.match(raw, /event: reload/)
    assert.match(raw, /"artifactId":"live\.html"/)
    assert.match(raw, /"version":1/)

    // Second update bumps the version.
    fs.writeFileSync(abs, '<!doctype html><html><body>v2</body></html>')
    s._noteArtifact(abs, 'test')
    await new Promise((r) => setTimeout(r, 30))
    const raw2 = chunks.join('')
    assert.match(raw2, /"version":2/)

    req.destroy()
  } finally {
    await s.close()
  }
})

test('artifact event is emitted with the resolved URL and version', async () => {
  const dir = tmpDir()
  const s = new ArtifactServer({ artifactDir: dir })
  const events = []
  s.on('artifact', (e) => events.push(e))
  try {
    await s.ensureStarted()
    const abs = path.join(dir, 'x.svg')
    fs.writeFileSync(abs, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    s._noteArtifact(abs, 'test')
    assert.equal(events.length, 1)
    assert.equal(events[0].artifactId, 'x.svg')
    assert.equal(events[0].kind, 'svg')
    assert.equal(events[0].version, 1)
    assert.match(events[0].url, /\/a\/x\.svg\//)

    s._noteArtifact(abs, 'test')
    assert.equal(events[1].version, 2)
  } finally {
    await s.close()
  }
})

test('close() releases the port', async () => {
  const dir = tmpDir()
  const s = new ArtifactServer({ artifactDir: dir })
  await s.ensureStarted()
  const port = s.port
  await s.close()
  // Trying to GET now should fail (connection refused). We give the OS a
  // moment to release the port.
  await new Promise((r) => setTimeout(r, 50))
  await assert.rejects(get(`http://127.0.0.1:${port}/health`))
})

test('extractPathCandidates pulls file paths from tool/result shapes', () => {
  const { _internal } = require('../src/main/artifact-ipc.js')
  const { extractPathCandidates } = _internal
  assert.deepEqual(extractPathCandidates({ filePath: '/w/.artifacts/a.html' }), ['/w/.artifacts/a.html'])
  assert.deepEqual(extractPathCandidates({ meta: { path: '/w/.artifacts/b.svg' } }), ['/w/.artifacts/b.svg'])
  assert.deepEqual(
    extractPathCandidates({ content: [{ type: 'text', text: 'wrote to ./.artifacts/c.md today' }] }),
    ['./.artifacts/c.md'],
  )
  // No text-block false positives on non-artifact extensions.
  assert.deepEqual(
    extractPathCandidates({ content: [{ type: 'text', text: 'saw file.txt earlier' }] }),
    [],
  )
  // Both structured and text extraction can coexist.
  const both = extractPathCandidates({
    filePath: '/w/.artifacts/a.html',
    content: [{ type: 'text', text: 'also wrote /w/.artifacts/b.md' }],
  })
  assert.ok(both.includes('/w/.artifacts/a.html'))
  assert.ok(both.includes('/w/.artifacts/b.md'))
})
