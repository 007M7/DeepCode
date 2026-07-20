/** Argument-delimiter handling shared by the SDK launcher and its invariant. */

/** Launcher-owned arguments and opaque arguments following `--`. */
export interface ForwardedArgumentSplit {
  /** Arguments parsed by the SDK launcher. */
  readonly launcher: readonly string[]
  /** Arguments passed unchanged to the selected project command. */
  readonly forwarded: readonly string[]
}

/**
 * Split the first `--` delimiter without interpreting either side.
 * @param argv - complete user argument vector.
 * @returns launcher arguments and post-delimiter arguments.
 */
export function splitForwardedArgs(argv: readonly string[]): ForwardedArgumentSplit {
  const separator = argv.indexOf('--')
  return separator === -1
    ? { launcher: argv, forwarded: [] }
    : { launcher: argv.slice(0, separator), forwarded: argv.slice(separator + 1) }
}
