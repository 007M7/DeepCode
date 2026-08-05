declare module '@deepseek-ai/dsh-type-meta' {
  export interface TypeRTLookup<Host, Wire> {
    readonly host: Host
    readonly wire: Wire
  }

  export interface TypeRTContext<Wire> {
    readonly wire: Wire
  }

  export interface TypeRTLookupMap {}
  export interface TypeRTContextMap {}
  export interface TypeRTRemoteMap {}
  export interface TypeRTRemoteContextMap {}

  export type TypeRTRemoteNamespace<Namespace extends string> = {
    [Endpoint in keyof TypeRTRemoteMap as Endpoint extends `${Namespace}/${infer Method}`
      ? Method
      : never]: TypeRTRemoteMap[Endpoint]
  }

  export interface TypeRTRemoteNamespaceMap {}

  export interface TypeRTRemoteContribution {
    readonly package: string
    readonly descriptors: readonly unknown[]
  }

  export function bindTypeRTGateway<Service extends object>(
    service: Service,
    serviceKey: string,
    options?: { readonly namespace?: string },
  ): { readonly service: Service; readonly serviceKey: string; readonly namespace: string }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  export function RemoteContext(key: Extract<keyof TypeRTContextMap, string>):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
