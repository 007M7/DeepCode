import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

// Load DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL from a gitignored repo-root .env
// (Node native). Absent file is fine — the environment may already carry them.
//
// IMPORTANT: this server speaks ACP JSON-RPC on stdout. Do NOT add any
// stdout logging here or in cordis.yml — it would corrupt the protocol frames.
// A present-but-unreadable/malformed .env is a real misconfiguration: surface
// it on STDERR (never stdout) rather than silently running with the wrong env.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
} catch (error) {
  if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
    process.stderr.write(`acp-agent: failed to load .env: ${String(error)}\n`)
  }
  // ENOENT (no .env) is fine — rely on the ambient environment.
}

const ctx = new Context()
ctx.baseUrl = pathToFileURL(import.meta.dirname).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    path: './cordis.yml',
  },
})
