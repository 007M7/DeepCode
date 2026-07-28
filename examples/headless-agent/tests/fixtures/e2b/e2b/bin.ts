import { resolve } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-e2b'
import type {} from '@deepseek-ai/dsh-fs-e2b'
import type {} from '@deepseek-ai/dsh-bash-local'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('usage: bin.ts <cordis.yml>')

const ctx = await boot('e2b-composition', resolve(configPath))
try {
  const fromFs = await ctx.fs.resolve('from-fs.txt')
  await ctx.fs.writeText(fromFs, 'written-by-fs\n', { kind: 'createIfAbsent' })
  const bashRead = await ctx.bash.run(ctx.bash.resolve({ command: 'cat from-fs.txt' }))
  if (bashRead.exitCode !== 0 || bashRead.stdout.text !== 'written-by-fs\n') {
    throw new Error(`E2B Bash could not read the FS write: ${JSON.stringify(bashRead)}`)
  }

  const bashWrite = await ctx.bash.run(ctx.bash.resolve({ command: "printf 'written-by-bash\\n' > from-bash.txt" }))
  if (bashWrite.exitCode !== 0) {
    throw new Error(`E2B Bash could not write the shared filesystem: ${JSON.stringify(bashWrite)}`)
  }
  const fromBash = await ctx.fs.resolve('from-bash.txt')
  const fsRead = await ctx.fs.readText(fromBash)
  process.stdout.write(`${JSON.stringify({
    sandboxId: await ctx.e2b.sandboxId,
    bashRead: bashRead.stdout.text,
    fsRead,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
