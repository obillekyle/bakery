import type { Handler } from '@server/handlers/core/$base'

export type ValidResponses = Handler.Response

export interface ServerPlugin {
  name: string
  setup?(config: ProcessedAppConfig): MixedPromise<void>
  onStart?(server: Bun.Server<any>): MixedPromise<void>
  onRequest?(req: Request): ValidResponses
  onRoute?(req: Request): MixedPromise<void>
  onError?(error: Handler.Error.Data, req?: Request): ValidResponses
  onShutdown?(): MixedPromise<void>
  onCompile?(content: string, path: string): MixedPromise<string>
}

export function definePlugin<T extends ServerPlugin>(plugin: T): T {
  return plugin
}
