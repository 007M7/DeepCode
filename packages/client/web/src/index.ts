/**
 * Web shell library entry. The shell's product is {@link bootWebShell} —
 * apps/web's vite entry calls it against #root; everything else (AppRoot
 * gate, assembly closure, module-table seed) is internal to the boot chain.
 * @module @deepseek-ai/dsh-client-web
 */

export { bootWebShell } from './boot.tsx'
export { AppRoot, type AppRootProps } from './AppRoot.tsx'
export { buildRenderApp, type AssemblyDeps } from './app.tsx'
export { DocumentTitle, type DocumentTitleProps } from './DocumentTitle.tsx'
export { seedModules } from './seed.ts'
