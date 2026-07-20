/**
 * Escape probe 2: a tsconfig `paths` mapping for the package name bypasses
 * exports/conditions resolution entirely (paths wins before node_modules is
 * consulted). The import below is the SAME specifier the conditions scheme
 * blocks — under tsconfig.escape-paths.json it resolves anyway.
 */
import { createEchoB } from '@dsh-spike/echo-b'

void createEchoB
