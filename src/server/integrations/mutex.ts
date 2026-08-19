// Ein Lauf-Lock je (Mandant, Integration): Mandanten blockieren sich nie
// gegenseitig, derselbe Mandant + dieselbe Integration läuft maximal einmal.
const running = new Map<string, Promise<unknown>>()

function key(tenantId: string, integrationId: string): string {
  return `${tenantId} ${integrationId}`
}

export function isRunning(tenantId: string, integrationId: string): boolean {
  return running.has(key(tenantId, integrationId))
}

export async function runExclusive<T>(
  tenantId: string,
  integrationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const k = key(tenantId, integrationId)
  if (running.has(k)) {
    throw new SyncBusyError(
      `integration "${integrationId}" is already running for tenant "${tenantId}"`,
    )
  }
  const promise = fn().finally(() => {
    if (running.get(k) === promise) running.delete(k)
  })
  running.set(k, promise)
  return promise
}

export class SyncBusyError extends Error {
  readonly code = "SYNC_BUSY"
  constructor(message: string) {
    super(message)
    this.name = "SyncBusyError"
  }
}
