/** Map one workspace source alias target to its declaration-build target. */
export function builtDeclarationPath(candidate: string): string {
  if (candidate.endsWith('/src')) {
    return `${candidate.slice(0, -'/src'.length)}/lib/types`
  }
  const sourceFile = /^(.*)\/src\/(.+)\.ts$/.exec(candidate)
  if (sourceFile?.[1] && sourceFile[2]) {
    return `${sourceFile[1]}/lib/types/${sourceFile[2]}.d.ts`
  }
  throw new Error(`doc-typecheck: cannot map workspace source path to built declarations: ${candidate}`)
}
