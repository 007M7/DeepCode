#!/usr/bin/env node
/**
 * Release verification. Always: every published package carries one shared
 * version, and — when running from a tag or publishing — the `vX.Y.Z` tag
 * matches it. With `--prebuilds`: every platform package's declared
 * binaries exist with the right ELF architecture (run after
 * `assemble-prebuilds.mjs` or a local `build:native`).
 */

import path from 'node:path';
import { packageDirs, platformDirs, readJson, root, verifyPlatformBinaries } from './repo.mjs';

function verifyVersions() {
  const packages = packageDirs().map((dir) => ({
    dir,
    manifest: readJson(path.join(root, dir, 'package.json')),
  }));
  const versions = new Set(packages.map((pkg) => pkg.manifest.version));
  if (versions.size !== 1) {
    throw new Error([
      'published package versions must match:',
      ...packages.map((pkg) => `${pkg.dir}: ${pkg.manifest.version}`),
    ].join('\n'));
  }

  const version = packages[0].manifest.version;
  const ref = process.env.GITHUB_REF || '';
  const publish = process.env.RELEASE_PUBLISH === 'true';
  if (publish && !ref.startsWith('refs/tags/v')) {
    throw new Error('publishing requires running the workflow from a v* tag');
  }
  if (ref.startsWith('refs/tags/v')) {
    const tagVersion = ref.slice('refs/tags/v'.length);
    if (tagVersion !== version) {
      throw new Error(`tag/version mismatch: tag v${tagVersion}, packages ${version}`);
    }
  }

  console.log(`Verified release version ${version}`);
}

function verifyPrebuilds() {
  for (const dir of platformDirs()) {
    const { name, count } = verifyPlatformBinaries(path.join(root, dir));
    console.log(`Verified ${name}: ${count} binaries`);
  }
}

verifyVersions();
if (process.argv.includes('--prebuilds')) {
  verifyPrebuilds();
}
