import { describe, it, expect } from "vitest"
import { isRunning, runExclusive, SyncBusyError } from "./mutex.js"
import type { SyncResult } from "./types.js"

const stubResult: SyncResult = {
  date: "2026-05-09",
  dryRun: true,
  durationMs: 0,
  projects: [],
  archived: [],
  errors: [],
}

describe("runExclusive", () => {
  it("runs the function and returns its result", async () => {
    const result = await runExclusive(async () => stubResult)
    expect(result).toBe(stubResult)
    expect(isRunning()).toBe(false)
  })

  it("rejects a second concurrent invocation with SyncBusyError", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = runExclusive(async () => {
      await gate
      return stubResult
    })

    expect(isRunning()).toBe(true)

    await expect(runExclusive(async () => stubResult)).rejects.toBeInstanceOf(SyncBusyError)

    release()
    await first
    expect(isRunning()).toBe(false)
  })

  it("releases the lock even when the function throws", async () => {
    await expect(
      runExclusive(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(isRunning()).toBe(false)
  })
})
