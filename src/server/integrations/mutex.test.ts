import { describe, it, expect } from "vitest"
import { isRunning, runExclusive, SyncBusyError } from "./mutex.js"

const T1 = "tenant-1"
const T2 = "tenant-2"

describe("runExclusive", () => {
  it("runs the function and returns its result", async () => {
    const result = await runExclusive(T1, "a", async () => "done")
    expect(result).toBe("done")
    expect(isRunning(T1, "a")).toBe(false)
  })

  it("rejects a second concurrent invocation for the same (tenant, id) with SyncBusyError", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = runExclusive(T1, "a", async () => {
      await gate
      return "first"
    })

    expect(isRunning(T1, "a")).toBe(true)

    await expect(runExclusive(T1, "a", async () => "second")).rejects.toBeInstanceOf(SyncBusyError)

    release()
    await first
    expect(isRunning(T1, "a")).toBe(false)
  })

  it("allows concurrent runs of different integrations", async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })

    const a = runExclusive(T1, "a", async () => {
      await gateA
      return "a"
    })

    expect(isRunning(T1, "a")).toBe(true)
    expect(isRunning(T1, "b")).toBe(false)

    const b = await runExclusive(T1, "b", async () => "b")
    expect(b).toBe("b")

    releaseA()
    await expect(a).resolves.toBe("a")
  })

  it("does not block the same integration across different tenants", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = runExclusive(T1, "a", async () => {
      await gate
      return "t1"
    })
    expect(isRunning(T1, "a")).toBe(true)
    expect(isRunning(T2, "a")).toBe(false)

    // Mandant 2 läuft parallel durch, während Mandant 1 noch hält.
    await expect(runExclusive(T2, "a", async () => "t2")).resolves.toBe("t2")

    release()
    await expect(first).resolves.toBe("t1")
  })

  it("releases the lock even when the function throws", async () => {
    await expect(
      runExclusive(T1, "a", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(isRunning(T1, "a")).toBe(false)
  })
})
