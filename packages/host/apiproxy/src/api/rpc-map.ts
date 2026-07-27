/**
 * RPC method registry and signature-derived generics. The map
 * registers only client-request methods (respond is a client-response, so it is absent);
 * map keys are the wire path segments (POST /api/session.list).
 */

import type { SessionsApi } from './sessions.ts'
import type { HostApi } from './host.ts'
import type { WorkspaceApi } from './workspace.ts'
import type { CommandsApi } from './commands.ts'
import type { SkillsApi } from './skills.ts'
import type { RpcResponse } from './rpc.ts'

/**
 * Method name → method signature. Signatures are the single source of truth; payload/value
 * types are always derived from here. A method may declare a trailing AbortSignal after the
 * request (command.execute): the carrier passes its request signal, never a wire field.
 */
export interface RpcMethodMap {
  'session.list': SessionsApi['list']
  'session.create': SessionsApi['create']
  'session.history': SessionsApi['history']
  'session.prompt': SessionsApi['prompt']
  'session.cancel': SessionsApi['cancel']
  'host.describe': HostApi['describe']
  'workspace.list': WorkspaceApi['list']
  'workspace.create': WorkspaceApi['create']
  'workspace.rename': WorkspaceApi['rename']
  'workspace.insertSessionBefore': WorkspaceApi['insertSessionBefore']
  'command.list': CommandsApi['list']
  'command.execute': CommandsApi['execute']
  'skill.list': SkillsApi['list']
}

/** Business request payload of method K (reaches through the RpcRequest narrow form to payload). */
export type RequestPayload<K extends keyof RpcMethodMap> = Parameters<RpcMethodMap[K]>[0]['payload']

/** Business return value of method K (reaches through the RpcResponse narrow form to infer the ok value of result). */
export type ResponseValue<K extends keyof RpcMethodMap> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
