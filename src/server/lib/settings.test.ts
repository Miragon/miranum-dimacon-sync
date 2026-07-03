import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "settings-test-"))
  path = join(dir, "settings.json")
  vi.stubEnv("SETTINGS_PATH", path)
  vi.resetModules()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function loadModule() {
  return import("./settings.js")
}

describe("settings", () => {
  it("seeds from env when the file does not exist", async () => {
    vi.stubEnv("SYNC_CRON", "0 6 * * *")
    vi.stubEnv("SYNC_TZ", "Europe/Vienna")
    const { getScheduleSettings } = await loadModule()

    const s = await getScheduleSettings("dimacon-clockin")
    expect(s).toEqual({ enabled: true, cron: "0 6 * * *", timezone: "Europe/Vienna" })

    const persisted = JSON.parse(await readFile(path, "utf-8")) as unknown
    expect(persisted).toEqual({
      integrations: {
        "dimacon-clockin": { enabled: true, cron: "0 6 * * *", timezone: "Europe/Vienna" },
      },
    })
  })

  it("migrates a legacy { sync: ... } file to the keyed shape", async () => {
    await writeFile(
      path,
      JSON.stringify({ sync: { enabled: true, cron: "0 5 * * *", timezone: "Europe/Berlin" } }),
      "utf-8",
    )
    const { getScheduleSettings } = await loadModule()

    const s = await getScheduleSettings("dimacon-clockin")
    expect(s).toEqual({ enabled: true, cron: "0 5 * * *", timezone: "Europe/Berlin" })

    const persisted = JSON.parse(await readFile(path, "utf-8")) as {
      integrations: Record<string, unknown>
      sync?: unknown
    }
    expect(persisted.integrations["dimacon-clockin"]).toEqual({
      enabled: true,
      cron: "0 5 * * *",
      timezone: "Europe/Berlin",
    })
    expect(persisted.sync).toBeUndefined()
  })

  it("returns a disabled default for unknown integration ids", async () => {
    const { getScheduleSettings } = await loadModule()
    const s = await getScheduleSettings("does-not-exist")
    expect(s.enabled).toBe(false)
    expect(s.timezone).toBe("Europe/Berlin")
  })

  it("serializes parallel updates so none are lost", async () => {
    const { getScheduleSettings, updateScheduleSettings } = await loadModule()

    await Promise.all([
      updateScheduleSettings("dimacon-clockin", {
        enabled: true,
        cron: "0 6 * * *",
        timezone: "Europe/Berlin",
      }),
      updateScheduleSettings("dimacon-lexoffice", {
        enabled: true,
        cron: "30 5 * * *",
        timezone: "Europe/Berlin",
      }),
    ])

    const persisted = JSON.parse(await readFile(path, "utf-8")) as {
      integrations: Record<string, { cron?: string }>
    }
    expect(persisted.integrations["dimacon-clockin"]?.cron).toBe("0 6 * * *")
    expect(persisted.integrations["dimacon-lexoffice"]?.cron).toBe("30 5 * * *")
    expect((await getScheduleSettings("dimacon-clockin")).cron).toBe("0 6 * * *")
    expect((await getScheduleSettings("dimacon-lexoffice")).cron).toBe("30 5 * * *")
  })

  it("updates one integration without touching the others", async () => {
    await writeFile(
      path,
      JSON.stringify({
        integrations: {
          "dimacon-clockin": { enabled: true, cron: "0 6 * * *", timezone: "Europe/Berlin" },
        },
      }),
      "utf-8",
    )
    const { getScheduleSettings, updateScheduleSettings } = await loadModule()

    await updateScheduleSettings("dimacon-lexoffice", {
      enabled: true,
      cron: "30 5 * * *",
      timezone: "Europe/Berlin",
    })

    expect(await getScheduleSettings("dimacon-clockin")).toEqual({
      enabled: true,
      cron: "0 6 * * *",
      timezone: "Europe/Berlin",
    })
    expect(await getScheduleSettings("dimacon-lexoffice")).toEqual({
      enabled: true,
      cron: "30 5 * * *",
      timezone: "Europe/Berlin",
    })
  })
})
