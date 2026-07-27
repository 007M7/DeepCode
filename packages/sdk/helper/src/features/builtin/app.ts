/**
 * Required run-interface app feature.
 *
 * @module @deepseek-ai/dsh-helper/features/builtin/app
 */

import { JsExpression } from '../../documents/cordis-yaml-file.ts'
import { featureId } from '../../ids.ts'
import type { ProjectProfile } from '../../project/types.ts'
import {
  createAppPackageScripts,
  createAppProjectArtifacts,
  createProjectTemplateContext,
} from '../../templates/project-template.ts'
import {
  FeatureOption,
  ExclusiveOptionFeature,
} from '../feature.ts'
import { ProjectContribution, type ProjectResource } from '../resources.ts'
import {
  cordisConfigEntry,
  npmCordisConfigEntry,
  optionalString,
  ownedTextFile,
  packageScript,
  requiredString,
} from './helpers.ts'

const ID = featureId('app')

function appProjectResources(
  profile: ProjectProfile,
  runInterface: 'acp' | 'tui' | 'embed',
): readonly ProjectResource[] {
  const context = createProjectTemplateContext(profile, runInterface)
  const scripts = createAppPackageScripts(context)
  return [
    ...createAppProjectArtifacts(context).map(document => (
      ownedTextFile(ID, document.relativePath, document.serialize())
    )),
    packageScript(ID, 'dev', scripts.dev),
    packageScript(ID, 'start', scripts.start),
  ]
}

class AppOption extends FeatureOption {
  override readonly id: 'acp' | 'tui' | 'embed'
  override readonly label: string

  constructor(id: 'acp' | 'tui' | 'embed', label: string) {
    super()
    this.id = id
    this.label = label
  }

  /** Identify options by their unique front door, not the shared interaction service. */
  override markerConfigEntries(): readonly { id: string; name: string }[] {
    switch (this.id) {
      case 'acp': return [{ id: 'acp', name: '@deepseek-ai/dsh-acp' }]
      case 'tui': return [{ id: 'tui', name: '@deepseek-ai/dsh-tui' }]
      case 'embed': return []
    }
  }

  /** Embed is identified by the configured loop with no external front door. */
  override matchesConfigEntries(entries: readonly { id: string; name: string }[], profile: ProjectProfile): boolean {
    if (this.id !== 'embed') return super.matchesConfigEntries(entries, profile)
    return entries.some(entry => entry.id === 'agent-loop' && entry.name === '@deepseek-ai/dsh-agent-loop')
      && !entries.some(entry => entry.name === '@deepseek-ai/dsh-acp' || entry.name === '@deepseek-ai/dsh-tui')
  }

  override contribution(profile: ProjectProfile): ProjectContribution {
    switch (this.id) {
      case 'acp':
        return new ProjectContribution([
          ...appProjectResources(profile, this.id),
          ...npmCordisConfigEntry(ID, {
            id: 'acp',
            name: '@deepseek-ai/dsh-acp',
            config: { model: profile.runtime.model },
          }, ['model'], config => requiredString(config, 'model')),
        ])
      case 'tui':
        return new ProjectContribution([
          ...appProjectResources(profile, this.id),
          ...npmCordisConfigEntry(ID, {
            id: 'user-interaction',
            name: '@deepseek-ai/dsh-user-interaction',
          }),
          cordisConfigEntry(ID, {
            id: 'tui-prompt',
            name: '@deepseek-ai/dsh-tui/prompt',
          }),
          ...npmCordisConfigEntry(ID, {
            id: 'tui',
            name: '@deepseek-ai/dsh-tui',
            config: {
              welcome: 'TUI agent ready. Give it a coding task.',
              sessionId: new JsExpression('process.env.DSH_SDK_SESSION_ID'),
            },
          }, ['welcome', 'sessionId'], config => [
            ...optionalString(config, 'welcome'),
            ...config.sessionId instanceof JsExpression ? [] : requiredString(config, 'sessionId'),
          ]),
        ])
      case 'embed':
        return new ProjectContribution(appProjectResources(profile, this.id))
    }
  }
}

/** Required app selection represented by ACP, TUI, or embed options. */
export class AppFeature extends ExclusiveOptionFeature {
  override readonly id = ID
  override readonly summary = 'Run interface'
  override readonly required = true
  override readonly requires = [featureId('spine')]
  override readonly options = [
    new AppOption('acp', 'ACP automation server'),
    new AppOption('tui', 'Terminal TUI'),
    new AppOption('embed', 'Embedded context'),
  ]

  /** Default to the profile's already selected front door. */
  override defaultOptions(profile: ProjectProfile): readonly string[] {
    return [profile.runInterface]
  }
}
