import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

// Load DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL from a gitignored repo-root .env
// (Node >= 21.7 native). Absent file is fine — the environment may already
// carry the variables; cordis.yml reads them via the `!!js` tag.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
} catch {
  // no .env — rely on the ambient environment
}

// Boot a Cordis app from this example's cordis.yml — the same shape as the
// upstream `cordis` bin, pinned to this directory.
const ctx = new Context()
ctx.baseUrl = pathToFileURL(import.meta.dirname).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    path: './cordis.yml',
  },
})
