import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

// Snapshot-test modes (set by the snapshot harness via env):
//   DSH_SNAPSHOT=replay  — load cordis.snapshot.yml (providerless; llm-replay
//                          serves a recorded session log). Skip .env so a stray
//                          key can never trigger a live model call.
//   DSH_SNAPSHOT=record  — load cordis.snapshot-record.yml (the real adapter +
//                          persistence) so a real run can be harvested.
// Absent — the normal demo (cordis.yml), driven by a real editor.
const snapshotMode = process.env.DSH_SNAPSHOT
const configPath = snapshotMode === 'replay' ? './cordis.snapshot.yml'
  : snapshotMode === 'record' ? './cordis.snapshot-record.yml'
    : './cordis.yml'

// Load DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL from a gitignored repo-root .env
// (Node native). Absent file is fine — the environment may already carry them.
// In REPLAY mode we deliberately skip this: replay must never reach the network,
// so we don't want a present .env to enable a live call.
//
// IMPORTANT: this server speaks ACP JSON-RPC on stdout. Do NOT add any
// stdout logging here or in cordis.yml — it would corrupt the protocol frames.
// A present-but-unreadable/malformed .env is a real misconfiguration: surface
// it on STDERR (never stdout) rather than silently running with the wrong env.
if (snapshotMode !== 'replay') {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      process.stderr.write(`acp-agent: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT (no .env) is fine — rely on the ambient environment.
  }
}

const ctx = new Context()
ctx.baseUrl = pathToFileURL(import.meta.dirname).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    path: configPath,
  },
})

// Graceful shutdown for snapshot RECORD runs: when the client closes our stdin
// (it is done driving the session), dispose the whole context. Disposal awaits
// the agent-loop teardown and the persistence backend's final `session/flush`,
// so the recorded `.jsonl` is fully written before the process exits and the
// harness harvests it. (In a normal editor session stdin stays open for the
// connection's lifetime; the editor kills the process, so this never fires.)
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
