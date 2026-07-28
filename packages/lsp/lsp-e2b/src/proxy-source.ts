/** Dependency-free remote stdio proxy installed inside the E2B sandbox. */

/**
 * Node program that base64-frames raw child stdio so E2B's text callbacks
 * never decode the language server's byte stream.
 */
export const LSP_PROXY_SOURCE = String.raw`import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const emit = (message) => {
  process.stdout.write(Buffer.from(JSON.stringify(message)).toString('base64') + '\n')
}

let argv
try {
  argv = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string')) throw new Error('invalid argv')
} catch (error) {
  process.stderr.write('lsp-e2b proxy argv error: ' + String(error) + '\n')
  process.exitCode = 125
  process.stdin.destroy()
}

if (argv) {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  child.stdout.on('data', data => { emit({ type: 'stdout', data: data.toString('base64') }) })
  child.stderr.on('data', data => { emit({ type: 'stderr', data: data.toString('base64') }) })
  child.on('error', error => {
    emit({ type: 'stderr', data: Buffer.from('language server spawn failed: ' + error.message).toString('base64') })
  })
  child.on('close', (code, signal) => {
    emit({ type: 'exit', code, signal })
    input.close()
    process.stdin.destroy()
    process.exitCode = code === null ? 1 : code
  })
  input.on('line', line => {
    input.pause()
    try {
      const message = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
      if (!message || message.type !== 'stdin' || typeof message.data !== 'string') throw new Error('invalid stdin frame')
      const data = Buffer.from(message.data, 'base64')
      if (data.toString('base64') !== message.data) throw new Error('invalid stdin base64')
      if (child.stdin.write(data)) input.resume()
      else child.stdin.once('drain', () => { input.resume() })
    } catch (error) {
      process.stderr.write('lsp-e2b proxy stdin error: ' + String(error) + '\n')
      child.kill('SIGTERM')
    }
  })
  input.on('close', () => { child.stdin.end() })
}
`
