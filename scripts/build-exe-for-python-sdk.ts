/**
 * Build the single-file SDK runtime executables
 * (docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
 *
 * Every settled decision is hardcoded — the PoC judged @yao-pkg/pkg's
 * standard mode unusable for this architecture (its ESM→CJS transform breaks
 * every runtime `import()`), so the pipeline is fixed on `--sea` mode, plain
 * ESM entry, plain-source assets, and a hoisted (symlink-free) staged tree.
 *
 * Pipeline — every step fails loud with the command it ran:
 *
 *   1. `pnpm run build` — all packages emit `lib/` (skippable via --skip-build).
 *   2. `pnpm --filter dsh-jsonrpc-agent-pkg deploy` — materialize the
 *      closure-manifest package (python/sdk-runtime/package.json — the single
 *      source of truth for the exe's plugin set) into the staging dir
 *      (cleared first; pnpm refuses a non-empty deploy target). Flags, all
 *      verified against pnpm 11.7: `--legacy` because the workspace does not
 *      set `inject-workspace-packages=true`; `node-linker=hoisted` for a plain
 *      file tree with zero symlinks (the safe shape for pkg's VFS, and it
 *      physically guarantees a single cordis copy); `auto-install-peers=false`
 *      so transitive `^0.0.x` peers on unpublished packages never hit the
 *      registry; `link-workspace-packages=true` so the closure resolves to
 *      workspace/vendor sources.
 *   3. Inject the pkg config into the staged package.json: `bin` = the ESM
 *      `node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js` (SEA mode
 *      hands it to Node's default ESM loader — no CJS shim), plus whole-tree
 *      asset globs. The cordis Loader resolves plugins
 *      through runtime dynamic `import()` of bare package names, so pkg's
 *      static analysis discovers none of them — the entire staged tree must be
 *      globbed in explicitly.
 *   4. `pnpm dlx @yao-pkg/pkg@<pinned> <staging> --sea --targets <t> --output
 *      <out>/dsh-jsonrpc-agent-pkg-<platform>-<arch>` — once per target (SEA mode
 *      packs a single target per invocation), so each product gets its
 *      canonical name directly.
 *   5. Sync into the Python runtime package
 *      (python/sdk-runtime/src/deepseek_harness_runtime/runtime/,
 *      created if missing): each product under its canonical filename (exe
 *      mode), plus the whole staged closure into runtime/node/ (node mode —
 *      `node runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js`
 *      runs it directly; the injected pkg
 *      fields are harmless to node). dist-exe/ keeps the originals for CI
 *      artifact upload.
 *
 *   `pnpm exec tsx scripts/build-exe-for-python-sdk.ts`            → host-platform exe into dist-exe/
 *   `pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64`
 *   `pnpm exec tsx scripts/build-exe-for-python-sdk.ts --dry-run`  → print the plan without executing
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/**
 * The deploy root: the closure-manifest package (python/sdk-runtime) whose
 * dependencies define the exe's contents; the runnable entry inside the
 * closure is {@link ENTRY_BIN}.
 */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg'
/** The bin entry inside the deployed closure (the dsh-jsonrpc-agent app bin). */
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js'
/** Basename of every product; the canonical name appends `-<platform>-<arch>`. */
const OUTPUT_BASENAME = 'dsh-jsonrpc-agent-pkg'
/** Default exe Node major; SEA mode requires >= node22, the repo tracks node24. */
const DEFAULT_NODE_RANGE = 'node24'
/** Pinned pkg version (the one the PoC and acceptance ran on) for reproducible builds. */
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
/** Staging dir for the deployed closure — cleared on every run (gitignored). */
// (No external staging dir: the deploy target IS the Python runtime's
// node-mode carrier — see PYTHON_RUNTIME_DIR/PYTHON_NODE_SUBDIR.)
/** Product output dir (gitignored). */
const OUT_DIR = 'dist-exe'
/**
 * Python runtime package dir the products are synced into. A parallel change
 * owns the directory and its .gitignore; this script's only contract is the
 * destination path, so a missing dir is created, never an error.
 */
const PYTHON_RUNTIME_DIR = 'python/sdk-runtime/src/deepseek_harness_runtime/runtime'
/** Subdir of {@link PYTHON_RUNTIME_DIR} carrying the staged closure for node-mode execution. */
const PYTHON_NODE_SUBDIR = 'node'
/** Deploy-root documentation is not runtime input and violates the generated-directory i18n exclusion if retained. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/**
 * Whole-tree asset globs. The cordis Loader dynamic-imports bare package names
 * at runtime, invisible to pkg's static analysis, so every runtime file in the
 * closure is listed; SEA mode ships them as plain source in the VFS. Every
 * package.json must ride along — bare-name resolution dies without them (the
 * json glob would already match, but the manifests are resolution-critical, so
 * they get their own explicit entry).
 */
const ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
]

const PLATFORMS = ['linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

/** True when `value` is a supported pkg platform tag. */
function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

/** True when `value` is a supported pkg CPU tag. */
function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/**
 * One pkg target triple, e.g. `node24-linux-x64`, as an immutable value.
 * Construction goes through {@link Target.parse} (a `--targets` entry) or
 * {@link Target.host} (the default), which own all validation.
 */
class Target {
  private constructor(
    /** pkg Node range (`node<major>`); pins the official base binary pkg pulls. */
    readonly nodeRange: string,
    /**
     * pkg platform tag. Windows is a documented non-goal
     * (docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
     */
    readonly platform: Platform,
    /** pkg CPU tag. */
    readonly arch: Arch,
  ) {}

  /** The pkg `--targets` spec string `<nodeRange>-<platform>-<arch>`. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse and validate one target spec; throws on any malformed component.
   * @param spec - the raw triple, e.g. `node24-linux-x64`.
   * @returns the parsed target.
   */
  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')} (Windows is a docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md non-goal), got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new Target(nodeRange, platform, arch)
  }

  /**
   * The default target when --targets is omitted: the host platform on node24.
   * @returns the host target; throws on an unsupported host platform or arch.
   */
  static host(): Target {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
    if (platform === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

/**
 * Parsed CLI configuration. {@link BuildCli.parse} is the only constructor
 * path — it owns flag parsing, target validation, and the --help / bad-flag
 * process exits, so an instance always holds a valid plan.
 */
class BuildCli {
  private constructor(
    /** Build targets; defaults to the host platform only. */
    readonly targets: readonly Target[],
    /** Skip step 1 (`pnpm run build`); lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Print every command and config patch instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv into a validated configuration. Exits the process for --help
   * (code 0, usage) and for unknown/malformed flags (code 1, usage on
   * stderr); throws on invalid or colliding targets.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-for-python-sdk: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-for-python-sdk: --targets is empty.')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = `${target.platform}-${target.arch}`
      if (seen.has(key)) {
        throw new Error(`build-exe-for-python-sdk: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
      }
      seen.add(key)
    }
    return new BuildCli(targets, values['skip-build'], values['dry-run'])
  }

  /** The flag grammar in one place; parseArgs throws on any unknown flag. */
  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  /** The --help text; also printed under flag-parse errors. */
  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-exe-for-python-sdk.ts [flags]',
      '',
      '  --targets=<t1,t2,...>  pkg targets, e.g. node24-linux-x64,node24-linux-arm64,node24-macos-arm64.',
      '                         Default: the host platform only (on node24).',
      '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --dry-run              print every command and config patch without executing.',
      '  --help                 print this help.',
      '',
      'Settled decisions are hardcoded (docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md): pkg runs in --sea mode',
      `(standard mode breaks runtime import()), pinned to ${PKG_SPEC}; the deploy tree is`,
      `hoisted/symlink-free; the closure deploys straight into ${PYTHON_RUNTIME_DIR}/${PYTHON_NODE_SUBDIR} and products land in ${OUT_DIR}/.`,
    ].join('\n')
  }
}

/** The pnpm executable name for the host OS. */
function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * Render a command line for logs and error messages, quoting arguments that
 * contain spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * The four-step build pipeline over one parsed CLI. Steps are sequential
 * async methods; every subprocess inherits stdio and fails loud with the
 * exact command it ran. In --dry-run the command/filesystem layer prints
 * what it would do instead of executing.
 */
class SingleExeBuild {
  /**
   * Absolute staging dir — the Python runtime's node-mode carrier: step 2
   * deploys the closure DIRECTLY here (cleared first; it is a pure build
   * product, the checked-in default `cordis.yml` lives one level up), step 4
   * reads it as the pkg input, and node mode runs it in place.
   */
  readonly staging = resolve(root, PYTHON_RUNTIME_DIR, PYTHON_NODE_SUBDIR)
  /** Absolute product output dir. */
  private readonly outDir = resolve(root, OUT_DIR)

  constructor(private readonly cli: BuildCli) {}

  /** Gate the manifest before spending time compiling or packaging it. */
  async verifyClosure(): Promise<void> {
    await this.run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'])
  }

  /** Step 1: `pnpm run build` — all packages emit `lib/` (skipped via --skip-build). */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-python-sdk: skipping pnpm run build (--skip-build)')
      return
    }
    await this.run('build', pnpmBin(), ['run', 'build'])
  }

  /** Step 2: clear the staging dir and deploy the bridge closure into it. */
  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-for-python-sdk: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.run('deploy', pnpmBin(), [
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      this.staging,
    ])
    if (this.cli.dryRun) {
      for (const name of DEPLOY_ONLY_DOCS) console.log(`build-exe-for-python-sdk: [dry-run] rm -f ${join(this.staging, name)}`)
    } else {
      await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(this.staging, name), { force: true })))
    }
  }

  /** Step 3: patch the staged package.json with the bin entry + pkg asset globs. */
  async injectPkgConfig(): Promise<void> {
    const patch = { bin: ENTRY_BIN, pkg: { assets: ASSET_GLOBS } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`build-exe-for-python-sdk: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    if (!existsSync(join(this.staging, ENTRY_BIN))) {
      throw new Error(`build-exe-for-python-sdk: ${join(this.staging, ENTRY_BIN)} missing — run without --skip-build so lib/ artifacts exist.`)
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`build-exe-for-python-sdk: injected pkg config into ${manifestPath}`)
  }

  /**
   * Step 4: run @yao-pkg/pkg over the staged tree for ONE target (SEA mode
   * packs a single target per invocation) and return the product path.
   * @param target - the pkg target triple to build.
   * @returns the canonical product path `<out>/dsh-jsonrpc-agent-pkg-<platform>-<arch>`.
   */
  async pack(target: Target): Promise<string> {
    const product = join(this.outDir, `${OUTPUT_BASENAME}-${target.platform}-${target.arch}`)
    if (!this.cli.dryRun) mkdirSync(this.outDir, { recursive: true })
    await this.run(`pkg ${target.spec}`, pnpmBin(), [
      'dlx',
      PKG_SPEC,
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      product,
    ])
    if (!this.cli.dryRun && !existsSync(product)) {
      throw new Error(`build-exe-for-python-sdk: product ${product} is missing after the pkg run; inspect ${this.outDir}.`)
    }
    return product
  }

  /**
   * Print each product path (and size, when it exists on disk).
   * @param products - the product paths returned by {@link pack}.
   */
  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'build-exe-for-python-sdk: [dry-run] would produce:' : 'build-exe-for-python-sdk: products:')
    for (const product of products) {
      if (this.cli.dryRun) {
        console.log(`  ${product}`)
        continue
      }
      const megabytes = statSync(product).size / (1024 * 1024)
      console.log(`  ${product}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /**
   * Step 5: copy every product into the Python runtime package under its
   * canonical filename (exe mode). The node-mode carrier needs no sync — step
   * 2 deployed the closure into it directly. dist-exe/ keeps the originals
   * for CI artifact upload; the destination dir is created if missing.
   * @param products - the product paths returned by {@link pack}.
   */
  async syncToPythonRuntime(products: string[]): Promise<void> {
    const destDir = resolve(root, PYTHON_RUNTIME_DIR)
    if (this.cli.dryRun) {
      for (const product of products) {
        console.log(`build-exe-for-python-sdk: [dry-run] cp ${product} ${join(destDir, basename(product))}`)
      }
      return
    }
    mkdirSync(destDir, { recursive: true })
    for (const product of products) {
      const destination = join(destDir, basename(product))
      await copyFile(product, destination)
      console.log(`build-exe-for-python-sdk: synced ${destination}`)
    }
  }

  /**
   * Run one pipeline step as a subprocess with inherited stdio; reject —
   * carrying the printable command — on spawn failure and non-zero exit
   * alike. In --dry-run, print the command instead of executing.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-for-python-sdk: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
      child.once('error', (error) => {
        reject(new Error(`build-exe-for-python-sdk: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-for-python-sdk: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}

/** Entry point: parse the CLI, then await each pipeline step in order. */
async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new SingleExeBuild(cli)
  console.log(`build-exe-for-python-sdk: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-python-sdk: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(await pipeline.pack(target))
  pipeline.printProducts(products)
  await pipeline.syncToPythonRuntime(products)
}

await main()
