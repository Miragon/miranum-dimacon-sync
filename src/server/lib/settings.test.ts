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
      fieldMappings: {},
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

  it("loads files without fieldMappings (older shape) with an empty default", async () => {
    await writeFile(
      path,
      JSON.stringify({
        integrations: {
          "dimacon-clockin": { enabled: false, timezone: "Europe/Berlin" },
        },
      }),
      "utf-8",
    )
    const { getFieldMapping } = await loadModule()
    expect(await getFieldMapping("dimacon-clockin", "project")).toBeUndefined()
  })

  it("round-trips field mappings without touching schedules", async () => {
    const { getFieldMapping, getScheduleSettings, updateFieldMapping, updateScheduleSettings } =
      await loadModule()

    await updateScheduleSettings("dimacon-clockin", {
      enabled: true,
      cron: "0 6 * * *",
      timezone: "Europe/Berlin",
    })
    const mapping = {
      version: 1 as const,
      rules: [
        {
          source: { kind: "standard" as const, field: "name" },
          target: { kind: "standard" as const, field: "name" },
        },
      ],
    }
    await updateFieldMapping("dimacon-clockin", "project", mapping)

    expect(await getFieldMapping("dimacon-clockin", "project")).toEqual(mapping)
    expect((await getScheduleSettings("dimacon-clockin")).cron).toBe("0 6 * * *")

    const persisted = JSON.parse(await readFile(path, "utf-8")) as {
      fieldMappings: Record<string, Record<string, unknown>>
    }
    expect(persisted.fieldMappings["dimacon-clockin"]?.project).toBeDefined()
  })

  it("deletes a mapping and prunes empty integration objects", async () => {
    const { getFieldMapping, updateFieldMapping } = await loadModule()

    await updateFieldMapping("dimacon-clockin", "project", {
      version: 1,
      rules: [],
    })
    await updateFieldMapping("dimacon-clockin", "project", null)

    expect(await getFieldMapping("dimacon-clockin", "project")).toBeUndefined()
    const persisted = JSON.parse(await readFile(path, "utf-8")) as {
      fieldMappings: Record<string, unknown>
    }
    expect(persisted.fieldMappings["dimacon-clockin"]).toBeUndefined()
  })

  it("migrates the removed dimacon-clockin-employees integration on load", async () => {
    await writeFile(
      path,
      JSON.stringify({
        integrations: {
          "dimacon-clockin": { enabled: false, timezone: "Europe/Berlin" },
          "dimacon-clockin-employees": {
            enabled: true,
            cron: "0 5 * * *",
            timezone: "Europe/Berlin",
          },
        },
        fieldMappings: {
          "dimacon-clockin-employees": {
            employee: {
              version: 1,
              rules: [
                {
                  source: { kind: "standard", field: "phoneNumber" },
                  target: { kind: "standard", field: "phone_work" },
                },
              ],
            },
          },
        },
      }),
      "utf-8",
    )
    const { getFieldMapping, getScheduleSettings } = await loadModule()

    // Mapping wandert unter dimacon-clockin, der alte Cron-Slot verschwindet
    const mapping = await getFieldMapping("dimacon-clockin", "employee")
    expect(mapping?.rules).toHaveLength(1)
    expect(await getFieldMapping("dimacon-clockin-employees", "employee")).toBeUndefined()
    expect((await getScheduleSettings("dimacon-clockin-employees")).enabled).toBe(false)

    const persisted = JSON.parse(await readFile(path, "utf-8")) as {
      integrations: Record<string, unknown>
      fieldMappings: Record<string, unknown>
    }
    expect(persisted.integrations["dimacon-clockin-employees"]).toBeUndefined()
    expect(persisted.fieldMappings["dimacon-clockin-employees"]).toBeUndefined()
    expect(persisted.fieldMappings["dimacon-clockin"]).toBeDefined()
  })

  it("keeps an existing dimacon-clockin employee mapping over the migrated one", async () => {
    const keep = {
      version: 1,
      rules: [
        {
          source: { kind: "standard", field: "email" },
          target: { kind: "standard", field: "email" },
        },
      ],
    }
    await writeFile(
      path,
      JSON.stringify({
        integrations: {},
        fieldMappings: {
          "dimacon-clockin": { employee: keep },
          "dimacon-clockin-employees": { employee: { version: 1, rules: [] } },
        },
      }),
      "utf-8",
    )
    const { getFieldMapping } = await loadModule()

    expect(await getFieldMapping("dimacon-clockin", "employee")).toEqual(keep)
  })

  it("does not rewrite files without the removed integration id", async () => {
    await writeFile(
      path,
      JSON.stringify({
        integrations: { "dimacon-clockin": { enabled: false, timezone: "Europe/Berlin" } },
        fieldMappings: {},
      }),
      "utf-8",
    )
    const before = await readFile(path, "utf-8")
    const { loadSettings } = await loadModule()
    await loadSettings()
    expect(await readFile(path, "utf-8")).toBe(before)
  })

  it("serializes parallel schedule and mapping updates", async () => {
    const { getFieldMapping, getScheduleSettings, updateFieldMapping, updateScheduleSettings } =
      await loadModule()

    await Promise.all([
      updateScheduleSettings("dimacon-clockin", {
        enabled: true,
        cron: "0 6 * * *",
        timezone: "Europe/Berlin",
      }),
      updateFieldMapping("dimacon-clockin", "customer", { version: 1, rules: [] }),
    ])

    expect((await getScheduleSettings("dimacon-clockin")).cron).toBe("0 6 * * *")
    expect(await getFieldMapping("dimacon-clockin", "customer")).toEqual({
      version: 1,
      rules: [],
    })
  })
})
