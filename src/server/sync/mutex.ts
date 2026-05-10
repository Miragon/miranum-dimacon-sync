import type { SyncResult } from "./types.js"

let current: Promise<SyncResult> | null = null

export function isRunning(): boolean {
  return current !== null
}

export async function runExclusive(fn: () => Promise<SyncResult>): Promise<SyncResult> {
  if (current) {
    throw new SyncBusyError("a sync run is already in progress")
  }
  const promise = fn().finally(() => {
    if (current === promise) current = null
  })
  current = promise
  return promise
}

export class SyncBusyError extends Error {
  readonly code = "SYNC_BUSY"
  constructor(message: string) {
    super(message)
    this.name = "SyncBusyError"
  }
}
