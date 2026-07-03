import { describe, it, expect } from "vitest"
import { isRunning, runExclusive, SyncBusyError } from "./mutex.js"

describe("runExclusive", () => {
  it("runs the function and returns its result", async () => {
    const result = await runExclusive("a", async () => "done")
    expect(result).toBe("done")
    expect(isRunning("a")).toBe(false)
  })

  it("rejects a second concurrent invocation for the same id with SyncBusyError", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = runExclusive("a", async () => {
      await gate
      return "first"
    })

    expect(isRunning("a")).toBe(true)

    await expect(runExclusive("a", async () => "second")).rejects.toBeInstanceOf(SyncBusyError)

    release()
    await first
    expect(isRunning("a")).toBe(false)
  })

  it("allows concurrent runs of different integrations", async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })

    const a = runExclusive("a", async () => {
      await gateA
      return "a"
    })

    expect(isRunning("a")).toBe(true)
    expect(isRunning("b")).toBe(false)

    const b = await runExclusive("b", async () => "b")
    expect(b).toBe("b")

    releaseA()
    await expect(a).resolves.toBe("a")
  })

  it("releases the lock even when the function throws", async () => {
    await expect(
      runExclusive("a", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(isRunning("a")).toBe(false)
  })
})
