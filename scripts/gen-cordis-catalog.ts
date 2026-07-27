/**
 * Generate the Cordis event and service catalogs from static declarations.
 * The walk enforces event modes, JSDoc parameter/return completeness, and
 * signature type-link coverage; inherited Cordis services come from the
 * curated table below. `--check` verifies both committed artifacts.
 */

import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import ts from 'typescript'
import { renderCordisCoreApiPages } from './cordis-core-api.ts'
import { checkParams, checkReturns, parseJsDoc, parseTags, pointer, rawJsDoc, reportViolations, type Mode } from './jsdoc.ts'
import { cordisModuleBody, eventMembers, serviceClasses } from './cordis-walk.ts'

const root = resolve(import.meta.dirname, '..')
const OUT_EVENTS = 'docs/cordis-catalog/events.md'
const OUT_SERVICES = 'docs/cordis-catalog/services.md'

/** The fenced-block info string for generated signature blocks (skipped by
 * doc-typecheck, since a bare signature fragment is not standalone-compilable). */
const FENCE = 'ts cordis-catalog'

/**
 * One primary subsystems page per project type used by a generated
 * signature. This stays curated because union names intentionally do not
 * reuse the type-equivalence manifest's map-symbol entries and some symbols
 * appear on more than one page.
 */
export const LINK_MAP: Record<string, string> = {
  Agent: 'core.md',
  AgentCancelCause: 'core.md',
  AgentOptions: 'core.md',
  AgentStatus: 'core.md',
  ContentBlock: 'core.md',
  ContinuationDecision: 'core.md',
  ContinuationStop: 'core.md',
  GenerateOptions: 'core.md',
  InboxPlacement: 'core.md',
  MessageId: 'core.md',
  HookContext: 'core.md',
  SettleReason: 'core.md',
  AdapterRegistrationHandle: 'core.md',
  DirectoryRegistrationHandle: 'core.md',
  LlmCallConfig: 'core.md',
  LlmModelContext: 'core.md',
  LlmModelReasoningInfo: 'core.md',
  LlmResolvedModelInfo: 'core.md',
  LlmFailure: 'llm-streaming.md',
  LlmModelInfo: 'core.md',
  LlmProviderInfo: 'core.md',
  LlmConfigurableProvider: 'core.md',
  LlmModelDiscoveryRequest: 'core.md',
  LlmDiscoveredModel: 'core.md',
  ResolvedRetryPolicy: 'llm-streaming.md',
  Message: 'core.md',
  MessageSource: 'core.md',
  UserMessage: 'session.md',
  PreStepDecision: 'core.md',
  PreStepContext: 'core.md',
  PromptDecision: 'core.md',
  RequestErrorAction: 'core.md',
  RequestError: 'core.md',
  RequestFailureContext: 'core.md',
  PreparedReferencedMessage: 'session-reference.md',
  SessionReferenceCandidate: 'session-reference.md',
  SessionReferenceInput: 'session-reference.md',
  SessionEvent: 'core.md',
  SessionId: 'core.md',
  SessionStartSource: 'core.md',
  SessionLogSnapshot: 'session-query.md',
  SessionSurfaceSnapshot: 'session-query.md',
  ApprovalOutcome: 'approval.md',
  ApprovalPolicy: 'approval.md',
  ApprovalRequest: 'approval.md',
  ApprovalService: 'approval.md',
  BashExecRequest: 'bash.md',
  BashExecSpec: 'bash.md',
  BashProcess: 'bash.md',
  BashRunResult: 'bash.md',
  DshEnvironment: 'subprocess.md',
  SubprocessHandle: 'subprocess.md',
  SubprocessOutcome: 'subprocess.md',
  SubprocessOutputRead: 'subprocess.md',
  SubprocessOutputReader: 'subprocess.md',
  SubprocessSpawnSpec: 'subprocess.md',
  SubprocessTerminalHandle: 'subprocess.md',
  SubprocessTerminalSpawnSpec: 'subprocess.md',
  CodeRunRequest: 'code-runtime.md',
  CodeRunResult: 'code-runtime.md',
  CompactionResult: 'compaction.md',
  CompactionTrigger: 'compaction.md',
  PruneResult: 'compaction.md',
  FileReadOutcome: 'filesystem.md',
  FsDirEntry: 'filesystem.md',
  FsEditOutcome: 'filesystem.md',
  FsEditRequest: 'filesystem.md',
  FsInfo: 'filesystem.md',
  FsPathInfo: 'filesystem.md',
  FsPolicyExec: 'filesystem.md',
  FsTarget: 'filesystem.md',
  FsVersion: 'filesystem.md',
  FsWriteIntent: 'filesystem.md',
  FsWriteOutcome: 'filesystem.md',
  CreateGoalRequest: 'goal.md',
  CreateGoalResult: 'goal.md',
  EditGoalRequest: 'goal.md',
  GoalBlockReason: 'goal.md',
  GoalChanged: 'goal.md',
  GoalRef: 'goal.md',
  GoalView: 'goal.md',
  CommandDefinition: 'commands.md',
  CommandDescriptor: 'commands.md',
  CommandResult: 'commands.md',
  CommandSurface: 'commands.md',
  LlmAdapter: 'llm-streaming.md',
  PreparedLlmCall: 'llm-streaming.md',
  LlmService: 'llm-streaming.md',
  StreamChunk: 'llm-streaming.md',
  CreateSessionOptions: 'persistence.md',
  PrepareSessionOptions: 'persistence.md',
  SessionHeader: 'persistence.md',
  SessionInspection: 'persistence.md',
  SessionLocation: 'persistence.md',
  SessionPreparation: 'persistence.md',
  SessionPersistenceSnapshot: 'persistence.md',
  ConfinedArgv: 'sandbox.md',
  SandboxExecutionPolicy: 'sandbox.md',
  SandboxMode: 'sandbox.md',
  SandboxPolicy: 'sandbox.md',
  PtyBackend: 'pty.md',
  PtyReadRequest: 'pty.md',
  PtyReadResult: 'pty.md',
  PtySendOperation: 'pty.md',
  PtySendRequest: 'pty.md',
  PtySessionId: 'pty.md',
  PtySessionSnapshot: 'pty.md',
  PtySignal: 'pty.md',
  PtySignalResult: 'pty.md',
  PtySpawnRequest: 'pty.md',
  PtySpawnResult: 'pty.md',
  SandboxPolicyRequest: 'sandbox.md',
  ScopeKey: 'scope.md',
  Scoped: 'scope.md',
  EpochHeader: 'session.md',
  Session: 'session.md',
  SessionEventMap: 'session.md',
  TurnEndReason: 'session.md',
  TurnTrigger: 'session.md',
  SessionEventReadRequest: 'session-query.md',
  SessionEventRecord: 'session-query.md',
  SessionEventResultFilter: 'session-query.md',
  SessionEventSearchDocument: 'session-query.md',
  SessionEventSearchHit: 'session-query.md',
  SessionEventSearchPage: 'session-query.md',
  SessionEventSearchRequest: 'session-query.md',
  SessionEventTrace: 'session-query.md',
  SessionEventTraceObservation: 'session-query.md',
  SessionEventTraceRequest: 'session-query.md',
  SessionEventWindow: 'session-query.md',
  SessionLineageTrace: 'session-query.md',
  SessionRecord: 'session-query.md',
  SessionResultFilter: 'session-query.md',
  SessionSearchExecContext: 'session-query.md',
  SessionSearchHit: 'session-query.md',
  SessionSearchPage: 'session-query.md',
  SessionSearchRequest: 'session-query.md',
  SessionTitleObservation: 'session-query.md',
  SessionTitleObservationResult: 'session-query.md',
  SessionTitleProvider: 'session-title.md',
  SessionTitleSnapshot: 'session-title.md',
  SkillDefinition: 'skills.md',
  SkillLookupOptions: 'skills.md',
  SkillProvider: 'skills.md',
  SkillRegistration: 'skills.md',
  SkillSummary: 'skills.md',
  SaveTextSpill: 'spill.md',
  SpillRef: 'spill.md',
  ContinuableCreateRequest: 'subagent.md',
  ContinuableCreateSpec: 'subagent.md',
  ContinuableSetupContribution: 'subagent.md',
  ContinuableStart: 'subagent.md',
  ContinuableStartSpec: 'subagent.md',
  CoordinatorMessageSource: 'subagent.md',
  SubagentDescendantListEntry: 'subagent.md',
  SubagentFollowupOptions: 'subagent.md',
  SubagentInterruptAuthority: 'subagent.md',
  SubagentListEntry: 'subagent.md',
  SubagentProvider: 'subagent.md',
  SubagentReportDelivery: 'subagent.md',
  SubagentReportMessageSource: 'subagent.md',
  SubagentReportOptions: 'subagent.md',
  SubagentRun: 'subagent.md',
  SubagentService: 'subagent.md',
  SubagentStartRequest: 'subagent.md',
  AssembleContext: 'system-prompt.md',
  PromptContext: 'system-prompt.md',
  PromptSection: 'system-prompt.md',
  SystemPrompt: 'system-prompt.md',
  ToolProviderResult: 'system-prompt.md',
  TaskDoneListener: 'tasks.md',
  TaskId: 'tasks.md',
  TaskRead: 'tasks.md',
  TaskSnapshot: 'tasks.md',
  TaskStart: 'tasks.md',
  TokenMeasurement: 'token-meter.md',
  CodeDispatchLog: 'tools.md',
  PostToolDecision: 'tools.md',
  PreToolDecision: 'tools.md',
  ToolDefinition: 'tools.md',
  ToolExecution: 'tools.md',
  ToolDispatchExecution: 'tools.md',
  ToolExecutionInput: 'tools.md',
  ToolExecutionMode: 'tools.md',
  ToolExecutionResult: 'tools.md',
  ToolExecutionToken: 'tools.md',
  ToolGuard: 'tools.md',
  ToolRegistry: 'tools.md',
  ToolRestriction: 'tools.md',
  ToolSchema: 'tools.md',
  SettingsNamespace: 'settings.md',
  SettingsRegisterOptions: 'settings.md',
  SettingsScope: 'settings.md',
  SettingsDescriptor: 'settings.md',
  SettingsPathOp: 'settings.md',
  SettingsDescribeOptions: 'settings.md',
  SettingsUpdateSource: 'settings.md',
  CredentialRef: 'credentials.md',
  CredentialInfo: 'credentials.md',
  ResolvedCredential: 'credentials.md',
  AskUserQuestionAnswer: 'user-interaction.md',
  AskUserQuestionRequest: 'user-interaction.md',
  UserInteractionProvider: 'user-interaction.md',
  WebFetchProvider: 'web.md',
  WebFetchRequest: 'web.md',
  WebFetchResult: 'web.md',
  WebSearchProvider: 'web.md',
  WebSearchRequest: 'web.md',
  WebSearchResult: 'web.md',
  WorkflowRun: 'workflow.md',
  WorkflowRunInfo: 'workflow.md',
  WorkflowStartRequest: 'workflow.md',
  PresetOption: 'permission.md',
  PresetSpec: 'permission.md',
  InvariantInstaller: 'invariants.md',
  WebRoute: 'http-server.md',
  StorageBackend: 'storage.md',
  StorageForms: 'storage.md',
  Domain: 'storage.md',
  DomainSpec: 'storage.md',
  DomainChanged: 'storage.md',
  DomainFacility: 'storage.md',
  Workspace: 'workspace.md',
  WorkspaceId: 'workspace.md',
  WebBootGraph: 'client-modules.md',
}

/** TypeScript lib and pinned framework types that have no repository-owned data page. */
const FOUNDATION_TYPE_NAMES = new Set([
  'AbortSignal',
  'AsyncIterable',
  'Context',
  'Error',
  'Partial',
  'Pick',
  'Promise',
  'Record',
  'Readonly',
])

/** Project types deliberately documented outside the subsystems catalog. */
const TYPE_LINK_EXEMPTIONS: Readonly<Record<string, string>> = {
  AgentFactory: 'agent creation seam is owned by packages/core/agent/README.md',
  z: 'schemastery schema constructor is owned by vendor/schemastery (vendored upstream)',
  BeginCommandRequest: 'event-local request contract is owned by packages/client/ui-slash/src/types.ts',
  InsertReferenceRequest: 'event-local request contract is owned by packages/client/ui-slash/src/types.ts',
  ConsumeTokenRequest: 'event-local request contract is owned by packages/client/ui-slash/src/types.ts',
  InsertTextRequest: 'event-local request contract is owned by packages/client/ui-slash/src/types.ts',
  AgentHandle: 'agent ownership handle is owned by packages/core/agent/README.md',
  BashEnvContributor: 'service-local extension type is owned by packages/bash/tool-bash/src/index.ts',
  BashEnvVariableInfo: 'service-local metadata type is owned by packages/bash/tool-bash/src/index.ts',
  CompactAgentContext: 'compaction service input is owned by packages/compact/compact/src/index.ts',
  ManualCompactAgentContext: 'manual compaction service input is owned by packages/compact/compact/src/index.ts',
  CreateAgentOptions: 'agent creation contract is owned by packages/core/agent/README.md',
  DomainImpl: 'domain implementation contract is owned by packages/storage/storage-domain/README.md',
  ProjectionDefinition: 'projection unit contract is owned by packages/session/session-projection/README.md',
  SessionProjectionMap: 'merge-extensible projection key map is owned by packages/session/session-projection/src/types.ts',
  ProjectionChangeListener: 'change-feed listener contract is owned by packages/session/session-projection/src/index.ts',
  ProjectionSnapshot: 'watermark snapshot shape is owned by packages/session/session-projection/src/index.ts',
  ProjectionCheckpoint: 'persisted checkpoint row map is owned by packages/session/session-projection/src/index.ts',
  CommandExecution: 'executor return contract is owned by packages/interaction/commands/src/index.ts',
  TypertContribution: 'registry contribution contract is owned by packages/typert/registry/README.md',
  TypertFace: 'registry face identity is owned by packages/typert/registry/README.md',
  TypertPackageFilter: 'registry package query filter is owned by packages/typert/registry/README.md',
  TypertPackageRecord: 'registry package record is owned by packages/typert/registry/README.md',
  TypertSchemaFilter: 'registry schema query filter is owned by packages/typert/registry/README.md',
  TypertSchemaRecord: 'registry schema record is owned by packages/typert/registry/README.md',
  TypeRTDisposer: 'TypeRT lifecycle contract is owned by packages/typert/type-meta/README.md',
  'z.core.JSONSchema.BaseSchema': 'zod projection output is owned by the zod v4 API',
  'z.core.ToJSONSchemaParams': 'zod projection parameters are owned by the zod v4 API',
  LocaleDict: 'service-local dictionary shape is owned by packages/client/i18n/src/index.ts',
  ThemeTokens: 'service-local token dictionary is owned by packages/client/ui-theme/src/index.ts',
  Translate: 'service-local bound translator is owned by packages/client/i18n/src/index.ts',
  WebUpgradeRoute:
    'upgrade route registration contract is owned by packages/host/webserver/src/index.ts',
  InvariantRegistration: 'service-local lifecycle handle is owned by packages/support/invariants/README.md',
  InvokeRemoteRequest: 'gateway invocation contract is owned by packages/api/gateway/README.md',
  KnobState: 'projection unit state shape is owned by packages/interaction/permission/README.md',
  PermissionSelect: 'permissions projection payload is owned by packages/interaction/permission/src/types.ts',
  PromptAssembly: 'assembly result is owned by packages/core/system-prompt/README.md',
  ResumeAgentOptions: 'agent resume contract is owned by packages/core/agent/README.md',
  Sandbox: 'external E2B SDK handle is owned by packages/e2b/e2b/README.md',
  SessionForkSource: 'service-local fork input is owned by packages/core/session/src/index.ts',
  SubagentRunEndInfo: 'event payload contract is owned by packages/subagent/subagent/src/types.ts',
  SubagentRunInfo: 'event payload contract is owned by packages/subagent/subagent/src/types.ts',
  TelemetryRecord: 'seam-local record contract is owned by packages/session/session-telemetry/src/index.ts',
  WorkflowAgentEndInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
  WorkflowAgentInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
  WorkflowResultInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
}

/** Collect named references from parameter, generic-constraint/default, and return types. */
function signatureTypeNames(member: ts.MethodSignature | ts.MethodDeclaration, sf: ts.SourceFile): string[] {
  const declared = new Set(member.typeParameters?.map(parameter => parameter.name.text) ?? [])
  const referenced = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) referenced.add(node.typeName.getText(sf))
    if (ts.isTypeQueryNode(node)) referenced.add(node.exprName.getText(sf))
    ts.forEachChild(node, visit)
  }
  for (const parameter of member.typeParameters ?? []) {
    if (parameter.constraint) visit(parameter.constraint)
    if (parameter.default) visit(parameter.default)
  }
  for (const parameter of member.parameters) {
    if (parameter.type) visit(parameter.type)
  }
  if (member.type) visit(member.type)
  return [...referenced].filter(name => !declared.has(name)).sort()
}

/** Append fail-closed signature type-link violations with actionable ownership choices. */
function checkTypeLinks(
  where: string,
  member: ts.MethodSignature | ts.MethodDeclaration,
  sf: ts.SourceFile,
  violations: string[],
): void {
  for (const name of signatureTypeNames(member, sf)) {
    if (Object.hasOwn(LINK_MAP, name)
      || FOUNDATION_TYPE_NAMES.has(name)
      || Object.hasOwn(TYPE_LINK_EXEMPTIONS, name)) continue
    violations.push(
      `${where} references unclassified type '${name}'. Add it to LINK_MAP with its subsystems page, `
      + 'to FOUNDATION_TYPE_NAMES if TypeScript or Cordis owns it, or to TYPE_LINK_EXEMPTIONS with '
      + 'the non-catalog documentation owner.',
    )
  }
}

/** Throw one aggregated diagnostic for every unclassified signature type. */
function reportTypeLinkViolations(gate: string, violations: string[]): void {
  if (violations.length === 0) return
  throw new Error(
    `${gate}: ${violations.length} signature type-link coverage violation(s):\n`
    + violations.map(violation => `  ${violation}`).join('\n'),
  )
}

/** One harness event, extracted from an `interface Events` block. */
interface EventEntry {
  /** Scoped name, e.g. `agent/request`. */
  name: string
  /** The scope prefix, e.g. `agent` (everything before the first `/`). */
  scope: string
  /** Full signature text (the method-signature member, JSDoc stripped). */
  signature: string
  /** Original declaration JSDoc, dedented from its containing interface. */
  jsDoc: string
  /** Dispatch mode from the `@mode` tag. */
  mode: Mode
  /** Description prose (JSDoc minus the `@mode` tag), one line per paragraph. */
  doc: string
  /** Source pointer `packages/…/file.ts:line` of the declaration. */
  source: string
}

/** One public service method and the source contract attached to it. */
interface ServiceMethodEntry {
  /** Public method signature (body stripped). */
  signature: string
  /** Original method JSDoc, dedented from its containing class. */
  jsDoc: string
}

/** One harness service, extracted from an `interface Context` block. */
interface ServiceEntry {
  /** The `ctx.<key>` name, e.g. `llm`. */
  key: string
  /** The service class/interface name, e.g. `LlmService`. */
  type: string
  /** Whether the service class is abstract (a seam interface). */
  abstract: boolean
  /** Class-level JSDoc prose, one line per paragraph. */
  doc: string
  /** Public methods (bodies stripped), in source order. */
  methods: ServiceMethodEntry[]
  /** Source pointer of the class declaration. */
  source: string
}

/** A terse inherited-tier entry (pinned vendor surface). */
interface InheritedEntry {
  name: string
  summary: string
  /** Source pointer `vendor/…:line`. */
  source: string
}

// cordisModuleBody / eventMembers / serviceClasses live in cordis-walk.ts.

/** The signature text of a method-signature member (everything but a body). */
function memberSignature(member: ts.TypeElement | ts.ClassElement, sf: ts.SourceFile): string {
  const full = member.getText(sf)
  const body = (member as { body?: ts.Node }).body
  const sig = body ? full.slice(0, full.length - body.getText(sf).length) : full
  return sig.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

/**
 * Copy a node's original JSDoc while removing only the indentation imposed by
 * its containing interface or class.
 */
function jsDocText(text: string, sf: ts.SourceFile, node: ts.Node): string {
  const raw = rawJsDoc(text, node)
  if (!raw) return ''
  const start = text.lastIndexOf(raw, node.getStart(sf))
  const { line } = sf.getLineAndCharacterOfPosition(start)
  const lineStart = sf.getPositionOfLineAndCharacter(line, 0)
  const indent = text.slice(lineStart, start)
  return raw.split('\n')
    .map((lineText, index) => index > 0 && lineText.startsWith(indent) ? lineText.slice(indent.length) : lineText)
    .join('\n')
}

/** Walk every harness `interface Events` block and extract its events, hard-
 * erroring (aggregated) on any JSDoc-completeness violation: a missing/
 * contradicted `@mode`, missing description prose, or an undocumented payload
 * parameter. `scanRoot` defaults to the repo root; tests pass a fixture dir. */
export function collectEvents(scanRoot: string = root): EventEntry[] {
  const entries: EventEntry[] = []
  const violations: string[] = []
  const typeLinkViolations: string[] = []
  for (const rel of globSync('packages/*/*/src/*.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('interface Events')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const body = cordisModuleBody(sf)
    if (!body) continue
    for (const { name, member } of eventMembers(body, sf)) {
      const signature = memberSignature(member, sf)
      const raw = rawJsDoc(text, member)
      const { doc, mode } = parseJsDoc(raw)
      const src = pointer(rel, sf, member)
      const where = `event '${name}' (${src})`
      checkTypeLinks(where, member, sf, typeLinkViolations)
      if (!mode) {
        violations.push(`${where} is missing an @mode tag. Add '@mode emit|waterfall|parallel|serial|bail' to its JSDoc (see AGENTS.md).`)
      }
      // Conclusive structural check: a trailing `next: () => …` parameter is a
      // waterfall. (emit vs parallel vs serial is not structurally
      // distinguishable, so it is trusted from the tag.)
      const last = member.parameters.at(-1)
      const hasNext = !!last && last.name.getText(sf) === 'next'
      if (mode && hasNext && mode !== 'waterfall') {
        violations.push(`${where} has a trailing 'next' parameter (structurally a waterfall) but is tagged '@mode ${mode}'. Fix the tag or the signature.`)
      }
      if (mode && !hasNext && mode === 'waterfall') {
        violations.push(`${where} is tagged '@mode waterfall' but has no trailing 'next' parameter. A waterfall delegates via next().`)
      }
      if (!doc) violations.push(`${where} has no description prose. Say what happened / what a listener may do, above the block tags.`)
      // Payload parameters need a non-empty @param. The `this` receiver is not
      // payload, and a waterfall's trailing `next` is covered by its mode.
      const { params } = parseTags(raw)
      checkParams(where, 'event', member.parameters, params, sf,
        p => (ts.isIdentifier(p.name) && p.name.text === 'this') || (hasNext && p === last), violations)
      if (mode) entries.push({ name, scope: name.split('/')[0] ?? name, signature, jsDoc: jsDocText(text, sf, member), mode, doc, source: src })
    }
  }
  reportViolations('gen-cordis-catalog', violations)
  reportTypeLinkViolations('gen-cordis-catalog', typeLinkViolations)
  return entries
}

/** Walk every harness `interface Context` block + its service class, hard-
 * erroring (aggregated) on any JSDoc-completeness violation: a class or public
 * method without JSDoc prose, an undocumented parameter, a stale `@param`, a
 * missing `@returns` on a non-void method, or an inferred (unannotated) return
 * type the pure-AST walk cannot classify.
 * `scanRoot` defaults to the repo root; tests pass a fixture dir. */
export function collectServices(scanRoot: string = root): ServiceEntry[] {
  const entries: ServiceEntry[] = []
  const violations: string[] = []
  const typeLinkViolations: string[] = []
  for (const rel of globSync('packages/*/*/src/index.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('interface Context')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const body = cordisModuleBody(sf)
    if (!body) continue
    // Resolve each ctx key to its service class (shared walk) and emit an entry.
    for (const { key, type, cls, abstract, doc: clsDoc } of serviceClasses(body, sf, rel, violations)) {
      const methods: ServiceMethodEntry[] = []
      for (const member of cls.members) {
        if (!ts.isMethodDeclaration(member)) continue
        // Only instance methods callable through `ctx.<key>` are surface;
        // private, protected, and static methods are not.
        const nonPublic = member.modifiers?.some(m =>
          m.kind === ts.SyntaxKind.PrivateKeyword
          || m.kind === ts.SyntaxKind.ProtectedKeyword
          || m.kind === ts.SyntaxKind.StaticKeyword)
          || ts.isPrivateIdentifier(member.name)
        if (nonPublic) continue
        const memberName = member.name.getText(sf)
        if (memberName.startsWith('[')) continue // computed/symbol members
        const where = `service method ctx.${key}.${memberName} (${pointer(rel, sf, member)})`
        checkTypeLinks(where, member, sf, typeLinkViolations)
        const raw = rawJsDoc(text, member)
        methods.push({ signature: memberSignature(member, sf), jsDoc: jsDocText(text, sf, member) })
        if (!raw) { violations.push(`${where} has no JSDoc.`); continue }
        if (!parseJsDoc(raw).doc) violations.push(`${where} has no description prose above its block tags.`)
        const { params, returns } = parseTags(raw)
        // Every parameter needs a non-empty @param (`this` receiver exempt),
        // and a non-void ANNOTATED result needs a non-empty @returns — the
        // shared checkers carry the exact contract.
        checkParams(where, 'service', member.parameters, params, sf,
          p => ts.isIdentifier(p.name) && p.name.text === 'this', violations)
        checkReturns(where, member.type, returns, sf, violations)
      }
      entries.push({
        key,
        type,
        abstract,
        doc: clsDoc,
        methods,
        source: pointer(rel, sf, cls),
      })
    }
  }
  reportViolations('gen-cordis-catalog', violations)
  reportTypeLinkViolations('gen-cordis-catalog', typeLinkViolations)
  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * The inherited tier — cordis core + loader/hmr/timer. Curated, terse, and
 * hand-summarized because (a) it is pinned vendor source that changes only on a
 * deliberate vendor sync, (b) the cordis-core `Context` mixes true ctx members
 * with non-service fields (`root`, `baseUrl`, `logger`) that a blind walk would
 * wrongly surface as services, and (c) the internal/* events carry no JSDoc to
 * render. Source pointers are verified against vendor by `verify-md-links`'
 * sibling check is N/A; keep them current on a vendor bump.
 */
const INHERITED_EVENTS: InheritedEntry[] = [
  { name: 'internal/plugin', summary: 'A plugin fiber was created.', source: 'vendor/cordis/src/events.ts:328' },
  { name: 'internal/status', summary: 'A fiber changed lifecycle state.', source: 'vendor/cordis/src/events.ts:330' },
  { name: 'internal/service', summary: 'Interception hook for a service binding (no core producer).', source: 'vendor/cordis/src/events.ts:332' },
  { name: 'internal/update', summary: 'Waterfall: a fiber config update is being applied.', source: 'vendor/cordis/src/events.ts:334' },
  { name: 'internal/get', summary: 'Waterfall: a service is being read from the store.', source: 'vendor/cordis/src/events.ts:336' },
  { name: 'internal/set', summary: 'Waterfall: a service is being written to the store.', source: 'vendor/cordis/src/events.ts:338' },
  { name: 'internal/listener', summary: 'A listener was registered.', source: 'vendor/cordis/src/events.ts:340' },
  { name: 'internal/dispatch', summary: 'An event is being dispatched to listeners.', source: 'vendor/cordis/src/events.ts:342' },
  { name: 'hmr/change', summary: 'A watched source file changed on disk.', source: 'vendor/hmr/src/index.ts:20' },
  { name: 'hmr/reload', summary: 'Plugins are being reloaded after a change.', source: 'vendor/hmr/src/index.ts:21' },
  { name: 'exit', summary: 'The process is exiting on a signal.', source: 'vendor/loader/src/index.ts:23' },
  { name: 'loader/config-update', summary: 'The loader config tree changed.', source: 'vendor/loader/src/index.ts:24' },
  { name: 'loader/entry-init', summary: 'A config entry is being initialized.', source: 'vendor/loader/src/index.ts:25' },
  { name: 'loader/partial-dispose', summary: 'An entry is being partially disposed on reload.', source: 'vendor/loader/src/index.ts:26' },
  { name: 'loader/patch-context', summary: 'A context is being patched during a reload.', source: 'vendor/loader/src/index.ts:27' },
]

export const INHERITED_SERVICES: InheritedEntry[] = [
  { name: 'ctx.on / ctx.once', summary: 'Register an event listener (disposable).', source: 'vendor/cordis/src/events.ts:34' },
  { name: 'ctx.emit / ctx.parallel / ctx.serial / ctx.bail / ctx.waterfall', summary: 'Dispatch an event (sync / awaited / first-bail / veto-chain).', source: 'vendor/cordis/src/events.ts:34' },
  { name: 'ctx.plugin / ctx.inject', summary: 'Load a plugin / declare required services.', source: 'vendor/cordis/src/registry.ts:164' },
  { name: 'ctx.effect', summary: 'Register a disposable side effect tied to the fiber.', source: 'vendor/cordis/src/fiber.ts:9' },
  { name: 'ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin', summary: 'Low-level service-store access and binding.', source: 'vendor/cordis/src/reflect.ts:7' },
  { name: 'ctx.extend / ctx.isolate / ctx.intercept', summary: 'Derive a child context (scoped services / isolation / interception).', source: 'vendor/cordis/src/context.ts:42' },
  { name: 'ctx.root / ctx.scope / ctx.fiber / ctx.registry / ctx.reflect / ctx.events / ctx.logger', summary: 'Ambient handles onto the running context graph.', source: 'vendor/cordis/src/context.ts:16' },
  { name: 'ctx.timer (+ interval / timeout / throttle / debounce / setTimeout / setInterval)', summary: 'Disposable timer helpers. The `timer` key is provided at runtime; the six helpers are mixed onto ctx directly (declared via Pick).', source: 'vendor/timer/src/index.ts:4' },
  { name: 'ctx.loader', summary: 'The config Loader that booted the app (present under the loader).', source: 'vendor/loader/src/index.ts:30' },
  { name: 'ctx.hmr', summary: 'The hot-module-reload watcher (present under the hmr plugin).', source: 'vendor/hmr/src/index.ts:15' },
]

/** Render the cross-link "Types:" line for a signature, or '' if none apply. */
function typeLinks(signature: string): string {
  const seen = new Set<string>()
  for (const name of Object.keys(LINK_MAP)) {
    if (new RegExp(`\\b${name}\\b`).test(signature)) seen.add(name)
  }
  if (seen.size === 0) return ''
  const links = [...seen].sort().map(n => `[${n}](../subsystems/${LINK_MAP[n]})`)
  return `Types: ${links.join(' · ')}`
}

/** Render one harness event entry. */
function renderEvent(e: EventEntry): string[] {
  const out = [`### \`${e.name}\` — ${e.mode}`, '']
  if (e.doc) out.push(e.doc, '')
  out.push('```' + FENCE, e.jsDoc, e.signature, '```', '')
  const links = typeLinks(e.signature)
  if (links) out.push(links, '')
  out.push(`Source: [\`${e.source}\`](../../${e.source.split(':')[0]})`, '')
  return out
}

/** Render one harness service entry. */
function renderService(s: ServiceEntry): string[] {
  const kind = s.abstract ? ' (abstract seam)' : ''
  const out = [`## \`ctx.${s.key}\` — \`${s.type}\`${kind}`, '']
  if (s.doc) out.push(s.doc, '')
  if (s.methods.length) {
    const declarations = s.methods.flatMap((method, index) => [
      ...(index > 0 ? [''] : []),
      method.jsDoc,
      method.signature,
    ])
    out.push('```' + FENCE, ...declarations, '```', '')
    const links = typeLinks(s.methods.map(method => method.signature).join('\n'))
    if (links) out.push(links, '')
  }
  out.push(`Source: [\`${s.source}\`](../../${s.source.split(':')[0]})`, '')
  return out
}

/** The shared generated-file banner comment. */
const BANNER = [
  '<!-- Generated by scripts/gen-cordis-catalog.ts — do not edit by hand.',
  '     Run `pnpm run gen-cordis-catalog` to regenerate. -->',
  '',
]

/** The shared GENERATED + freshness-gate + fence notice paragraph. */
const GATE_NOTICE = 'This file is GENERATED from source (`scripts/gen-cordis-catalog.ts`) and verified fresh by `pnpm run verify-cordis-catalog` (part of `doc-sync`) — do not edit it by hand. Signature blocks use a `ts cordis-catalog` fence and include the original source JSDoc immediately before each event or service method. doc-typecheck skips these bare declaration fragments; type names in a signature link to the page that documents them.'

/** Render the events catalog (pure, deterministic given sorted inputs). */
export function renderEvents(events: EventEntry[]): string {
  const lines: string[] = [
    ...BANNER,
    '# Cordis Events Catalog',
    '',
    'Every cordis event a plugin can listen to: exact signature, dispatch mode, and original declaration JSDoc. This is one axis of the **wiring** reference a plugin author works against — the callable `ctx.<key>` surface is the sibling [services catalog](services.md), and [subsystems/](../subsystems/core.md) catalogs the *data structures* these signatures move around.',
    '',
    GATE_NOTICE,
    '',
    'The **harness tier** below (the `@deepseek-ai/dsh-*` packages) is the vocabulary this repo owns, grouped by scope. The **inherited tier** at the end is the cordis-core + loader/hmr/timer event surface a plugin also sees — pinned vendor source, summarized tersely. The event-dispatch methods themselves are generated in the [Cordis core Events API](core/events.md).',
    '',
    'Dispatch modes: **emit** (fire-and-forget), **waterfall** (each listener gets `next()` and may transform or veto — see [waterfall semantics](../cordis-primer.md#cordis-waterfall-semantics)), **parallel** (awaited fan-out; all listeners run), **serial** (awaited in registration order until one returns a bail value — anything other than `null`, `false`, or `undefined`), **bail** (synchronous in-order dispatch until one listener returns a bail value; the scoped input-mutation events use it for an applied/not-applied answer).',
    '',
  ]
  const scopes = [...new Set(events.map(e => e.scope))].sort()
  for (const scope of scopes) {
    lines.push(`## \`${scope}/*\``, '')
    for (const e of events.filter(x => x.scope === scope).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(...renderEvent(e))
    }
  }
  lines.push(
    '## Inherited events (cordis core + loader/hmr/timer)',
    '',
    'The framework events every plugin also sees, beyond the harness vocabulary above. This is pinned vendor source ([vendoring policy](../../vendor/README.md)); it is summarized here so the page is a complete picture of the event bus, without elevating framework internals to the harness tier\'s prominence.',
    '',
  )
  for (const e of INHERITED_EVENTS) {
    lines.push(`- \`${e.name}\` — ${e.summary} ([\`${e.source}\`](../../${e.source.split(':')[0]}))`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Render the services catalog (pure, deterministic given sorted inputs). */
export function renderServices(services: ServiceEntry[]): string {
  const lines: string[] = [
    ...BANNER,
    '# Cordis Services Catalog',
    '',
    'Every `ctx.<key>` service a plugin can call: the exact public interface with original method JSDoc, plus the class JSDoc. This is one axis of the **wiring** reference a plugin author works against — the events a plugin listens to are the sibling [events catalog](events.md), and [subsystems/](../subsystems/core.md) catalogs the *data structures* these signatures move around. An abstract seam (e.g. `ctx.bash`) is implemented by a separate package; the interface is what consumers code against.',
    '',
    GATE_NOTICE,
    '',
    'The **harness tier** below (the `@deepseek-ai/dsh-*` packages) is the vocabulary this repo owns. The **inherited tier** at the end is the cordis-core + loader/hmr/timer `ctx` surface a plugin also sees — pinned vendor source, summarized tersely. Detailed Context, Fiber, Registry, and Service APIs are generated in the [Cordis core API](core/context.md).',
    '',
  ]
  for (const s of services) lines.push(...renderService(s))
  lines.push(
    '## Inherited `ctx` members (cordis core + loader/hmr/timer)',
    '',
    'The framework `ctx` surface every plugin also sees, beyond the harness services above. This is pinned vendor source ([vendoring policy](../../vendor/README.md)); it is summarized here so the page is a complete picture of what `ctx` offers, without elevating framework internals to the harness tier\'s prominence.',
    '',
  )
  for (const s of INHERITED_SERVICES) {
    lines.push(`- \`${s.name}\` — ${s.summary} ([\`${s.source}\`](../../${s.source.split(':')[0]}))`)
  }
  lines.push('')
  return lines.join('\n')
}

/** CLI entry: `--write` (default) writes both catalogs, `--check` fails if
 * either is stale. Guarded behind an entry-point check so importing this module
 * for tests neither regenerates the committed files nor calls process.exit. */
function main(): void {
  const outputs: [string, string][] = [
    [OUT_EVENTS, renderEvents(collectEvents())],
    [OUT_SERVICES, renderServices(collectServices())],
    ...renderCordisCoreApiPages(),
  ]
  if (process.argv.includes('--check')) {
    const stale: string[] = []
    for (const [out, content] of outputs) {
      let committed: string | null = null
      try {
        committed = readFileSync(resolve(root, out), 'utf8')
      } catch {
        // Only ENOENT (not yet generated) is expected; a present-but-unreadable
        // file is not a state this repo produces. Either way the remedy is the
        // same — regenerate — so treat a read failure as "stale".
        committed = null
      }
      if (committed !== content) stale.push(out)
    }
    if (stale.length === 0) {
      console.log(`gen-cordis-catalog: ${outputs.length} generated file(s) are up to date.`)
      process.exit(0)
    }
    console.error(`gen-cordis-catalog: ${stale.join(' and ')} ${stale.length === 1 ? 'is' : 'are'} stale. Run \`pnpm run gen-cordis-catalog\` and commit the result.`)
    process.exit(1)
  }

  for (const [out, content] of outputs) {
    const destination = resolve(root, out)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
  console.log(`gen-cordis-catalog: wrote ${outputs.length} generated file(s).`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
