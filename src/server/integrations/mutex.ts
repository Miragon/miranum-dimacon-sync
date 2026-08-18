const running = new Map<string, Promise<unknown>>()

export function isRunning(id: string): boolean {
  return running.has(id)
}

export async function runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(id)) {
    throw new SyncBusyError(`integration "${id}" is already running`)
  }
  const promise = fn().finally(() => {
    if (running.get(id) === promise) running.delete(id)
  })
  running.set(id, promise)
  return promise
}

export class SyncBusyError extends Error {
  readonly code = "SYNC_BUSY"
  constructor(message: string) {
    super(message)
    this.name = "SyncBusyError"
  }
}
