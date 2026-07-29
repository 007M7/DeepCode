/**
 * Pins the launcher side of the shared-session-store contract: `dsh` defaults
 * its opaque `SESSIONS_ROOT_KEY` boot-slot value to `DSH_HOME/sessions`. The
 * plugin side — the slot treated as opaque, explicit config winning, and a
 * project-local fallback with no globality assumption — is pinned by
 * `packages/examples/tui-demo/tests/tui-agent.spec.ts`.
 */

import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launcherSessionsRoot } from '../src/tui.ts'

afterEach(() => vi.unstubAllEnvs())

describe('launcherSessionsRoot', () => {
  it('defaults the boot slot to sessions under DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-slot-home')
    expect(launcherSessionsRoot()).toBe(resolve(join('/tmp/dsh-slot-home', 'sessions')))
  })
})
