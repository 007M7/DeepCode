# dsh-paths

Shared filesystem path helpers for DeepSeek Harness user data.

## DSH home

`DSH_HOME_DIR_NAME` owns the default user-data directory name: `.dsh`.

`defaultDshHome()` returns the default DeepSeek Harness home by joining the operating-system home directory with `.dsh`, using Node's platform path rules.

`expandHomePath()` expands `~`, `~/...`, and Windows-style `~\...` prefixes against the operating-system home directory. It leaves non-tilde paths and `~user/...` untouched.

This package is intentionally small and harness-dep-free so product packages can share user-data path conventions without depending on one another.
