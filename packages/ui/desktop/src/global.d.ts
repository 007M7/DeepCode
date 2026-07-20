export {}

declare global {
  interface Window {
    dshDesktop: {
      runtime: {
        start(): Promise<unknown>
        stop(): Promise<unknown>
        restart(): Promise<unknown>
        status(): Promise<unknown>
        onStatus(callback: (payload: unknown) => void): () => void
        onStderr(callback: (payload: unknown) => void): () => void
      }
      sessions: {
        list(): Promise<unknown>
        create(): Promise<unknown>
        load(sessionId: string): Promise<unknown>
        prompt(sessionId: string, text: string): Promise<unknown>
        cancel(sessionId: string): Promise<unknown>
        reveal(sessionId: string): Promise<unknown>
        onUpdate(callback: (payload: unknown) => void): () => void
      }
      trace: {
        read(sessionId: string): Promise<unknown>
      }
      feedback: {
        list(sessionId: string, targetId?: string): Promise<unknown>
        add(entry: Record<string, unknown>): Promise<unknown>
      }
      dev: {
        status(): Promise<unknown>
        openPath(path: string): Promise<unknown>
      }
      interaction: {
        onRequest(callback: (payload: unknown) => void): () => void
        respond(id: string, response: unknown): Promise<unknown>
      }
    }
  }
}
