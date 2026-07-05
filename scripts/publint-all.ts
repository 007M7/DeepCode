import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// publint every harness package. Packages live at packages/<group>/<pkg>
// (the group dirs — core/llm/bash/… — are pure containers); vendor/ is private
// upstream code and examples/ are not packages, both out of scope. Derived
// from the hierarchy so a new package needs no edit here.
const root = resolve(import.meta.dirname, '..')
const packagesRoot = resolve(root, 'packages')

const packages = readdirSync(packagesRoot, { withFileTypes: true })
  .filter(group => group.isDirectory())
  .flatMap(group =>
    readdirSync(resolve(packagesRoot, group.name), { withFileTypes: true })
      .filter(pkg => pkg.isDirectory())
      .filter(pkg => existsSync(resolve(packagesRoot, group.name, pkg.name, 'package.json')))
      .map(pkg => `packages/${group.name}/${pkg.name}`),
  )

for (const path of packages) {
  execFileSync('node_modules/.bin/publint', [path], { cwd: root, stdio: 'inherit' })
}
