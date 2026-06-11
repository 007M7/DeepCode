import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

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
