/**
 * Boot-time backend resolution for the adaptive directory-picker composition:
 * one pure decision from sampled host facts to a concrete backend kind. The
 * caller samples exactly once per boot, so the mounted capability stays
 * stable for the service lifetime as the seam requires.
 * @module @deepseek-ai/dsh-host-directory-picker-auto/resolve
 */

/** Concrete interaction backend the resolver chooses between. */
export type DirectoryPickerBackendKind = 'native' | 'browse'

/** Environment keys the resolution reads (a `process.env` subset). */
export type DirectoryPickerEnv = Readonly<
  Partial<Record<'SSH_CONNECTION' | 'SSH_TTY' | 'DISPLAY' | 'WAYLAND_DISPLAY', string>>
>

/** Host facts the backend choice is a pure function of, sampled once at boot. */
export interface DirectoryPickerHostFacts {
  /** Effective webserver bind host (`127.0.0.1` or `0.0.0.0`). */
  bindHost: string
  /** Host process platform. */
  platform: NodeJS.Platform
  /** Environment sample; SSH marks a remote operator, DISPLAY/WAYLAND_DISPLAY a Linux display. */
  env: DirectoryPickerEnv
}

/** An env value counts only when set and non-blank (an empty export is "unset" by shell convention). */
const present = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * Resolve which backend serves this boot. `native` requires every signal that
 * the operator can see the host display: a loopback-only bind (an
 * all-interfaces bind admits remote browsers no OS chooser can reach), no SSH
 * launch (under SSH port-forwarding the chooser would open on the unattended
 * server), and a display session (assumed on darwin/win32, `DISPLAY`/
 * `WAYLAND_DISPLAY` elsewhere). Anything ambiguous resolves to `browse`,
 * which works everywhere.
 * @param facts - the sampled host facts.
 * @returns the backend kind to mount.
 */
export function resolveDirectoryPickerBackend(facts: DirectoryPickerHostFacts): DirectoryPickerBackendKind {
  if (facts.bindHost !== '127.0.0.1') return 'browse'
  if (present(facts.env.SSH_CONNECTION) || present(facts.env.SSH_TTY)) return 'browse'
  if (facts.platform === 'darwin' || facts.platform === 'win32') return 'native'
  return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? 'native' : 'browse'
}
