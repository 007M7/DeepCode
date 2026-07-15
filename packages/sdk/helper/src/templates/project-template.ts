/**
 * Strict Handlebars wrapper and complete-file SDK project artifacts.
 *
 * @module @deepseek-ai/dsh-helper/templates/project-template
 */

import { PackageJsonFile } from '../documents/package-json-file.ts'
import { TextProjectFile } from '../documents/project-file.ts'
import type { PackageManagerName } from '../package-managers/package-manager.ts'
import { baselineNpmDependencies } from '../project/npm-dependency-policy.ts'
import { loadHelperTemplate } from './template-assets.ts'
import type { TextTemplate } from './text-template.ts'

/** Stable typed view consumed by all generated text artifacts. */
export interface ProjectTemplateContext {
  name: string
  description: string
  releaseVersion: string
  model: string
  modelLiteral: string
  isAcp: boolean
  isStdio: boolean
  isEmbed: boolean
  packageManager: PackageManagerName
  installArgs: string
  buildArgs: string
}

/** Complete project-file template artifact. */
export class TemplateArtifact<TModel extends object> extends TextProjectFile {
  /** Render and own one complete project file. */
  constructor(relativePath: string, template: TextTemplate<TModel>, model: TModel) {
    super(relativePath, template.render(model))
  }
}

const README_TEMPLATE = loadHelperTemplate<ProjectTemplateContext>('README.md.tpl')
const PACKAGE_JSON_TEMPLATE = loadHelperTemplate<{
  name: string
  description: string
  devScript: string
  startScript: string
  dependencies: string
  devDependencies: string
}>('package.json.tpl')
const INDEX_TEMPLATE = loadHelperTemplate<ProjectTemplateContext>('index.ts.tpl')
const TSDOWN_TEMPLATE = loadHelperTemplate<ProjectTemplateContext>('tsdown.config.ts.tpl')
const TSCONFIG_BASE_TEMPLATE = loadHelperTemplate<ProjectTemplateContext>('tsconfig.base.json.tpl')
const GITIGNORE_TEMPLATE = loadHelperTemplate<ProjectTemplateContext>('gitignore.tpl')
const YARNRC_TEMPLATE = loadHelperTemplate<ProjectTemplateContext>('yarnrc.yml.tpl')

/** Render the complete root package defaults before structured contributions merge. */
export function createPackageJsonDoc(context: ProjectTemplateContext): PackageJsonFile {
  const stdioModelArg = context.isStdio ? ` -- --model=${JSON.stringify(context.model)}` : ''
  const npmDependencies = baselineNpmDependencies(context.releaseVersion)
  return PackageJsonFile.create(PACKAGE_JSON_TEMPLATE.render({
    name: JSON.stringify(context.name),
    description: JSON.stringify(context.description),
    devScript: JSON.stringify(`dsh dev index.ts${stdioModelArg}`),
    startScript: JSON.stringify(`dsh start index.js${stdioModelArg}`),
    dependencies: JSON.stringify(npmDependencies.dependencies),
    devDependencies: JSON.stringify(npmDependencies.devDependencies),
  }))
}

/** Build every one-shot project artifact from one template context. */
export function createProjectArtifacts(context: ProjectTemplateContext): TemplateArtifact<ProjectTemplateContext>[] {
  return [
    new TemplateArtifact('README.md', README_TEMPLATE, context),
    new TemplateArtifact('index.ts', INDEX_TEMPLATE, context),
    new TemplateArtifact('tsdown.config.ts', TSDOWN_TEMPLATE, context),
    new TemplateArtifact('tsconfig.base.json', TSCONFIG_BASE_TEMPLATE, context),
    new TemplateArtifact('.gitignore', GITIGNORE_TEMPLATE, context),
    ...context.packageManager === 'yarn'
      ? [new TemplateArtifact('.yarnrc.yml', YARNRC_TEMPLATE, context)]
      : [],
  ]
}
