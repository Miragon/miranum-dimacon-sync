import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { log } from "./log.js"

export const ScheduleSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).default("Europe/Berlin"),
})

export type ScheduleSettings = z.infer<typeof ScheduleSettingsSchema>

const SettingsFileSchema = z.object({
  integrations: z.record(z.string(), ScheduleSettingsSchema),
})

/** Alte Dateiform (eine einzige Sync-Konfiguration) — wird beim Laden migriert. */
const LegacyFileSchema = z.object({
  sync: ScheduleSettingsSchema,
})

export type SettingsFile = z.infer<typeof SettingsFileSchema>

const DEFAULT_PATH = "./data/settings.json"
const LEGACY_INTEGRATION_ID = "dimacon-clockin"

export const DEFAULT_SCHEDULE: ScheduleSettings = {
  enabled: false,
  timezone: "Europe/Berlin",
}

function settingsPath(): string {
  return process.env.SETTINGS_PATH ?? DEFAULT_PATH
}

let cache: SettingsFile | undefined

export async function loadSettings(): Promise<SettingsFile> {
  if (cache) return cache
  const path = settingsPath()

  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      cache = seedFromEnv()
      await persist(cache)
      log.info("settings file seeded", { path, source: "env" })
      return cache
    }
    throw err
  }

  const parsed: unknown = JSON.parse(raw)

  const modern = SettingsFileSchema.safeParse(parsed)
  if (modern.success) {
    cache = modern.data
    return cache
  }

  const legacy = LegacyFileSchema.safeParse(parsed)
  if (legacy.success) {
    cache = { integrations: { [LEGACY_INTEGRATION_ID]: legacy.data.sync } }
    await persist(cache)
    log.info("settings file migrated from legacy shape", { path })
    return cache
  }

  throw new Error(`settings file at ${path} has an unrecognized shape`)
}

export async function getScheduleSettings(integrationId: string): Promise<ScheduleSettings> {
  const file = await loadSettings()
  return file.integrations[integrationId] ?? DEFAULT_SCHEDULE
}

// Serialisiert alle Updates (read-modify-write): parallele PUTs auf
// verschiedene Integrationen dürfen sich nicht gegenseitig überschreiben.
let writeChain: Promise<unknown> = Promise.resolve()

export async function updateScheduleSettings(
  integrationId: string,
  input: ScheduleSettings,
): Promise<ScheduleSettings> {
  const task = writeChain.then(async () => {
    const current = await loadSettings()
    const next: SettingsFile = {
      ...current,
      integrations: { ...current.integrations, [integrationId]: input },
    }
    await persist(next)
    cache = next
    return input
  })
  writeChain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

async function persist(data: SettingsFile): Promise<void> {
  const path = settingsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8")
  await rename(tmp, path)
}

function seedFromEnv(): SettingsFile {
  const cronEnv = process.env.SYNC_CRON?.trim()
  const tzEnv = process.env.SYNC_TZ?.trim()
  const cron = cronEnv && cronEnv.length > 0 ? cronEnv : undefined
  return {
    integrations: {
      [LEGACY_INTEGRATION_ID]: {
        enabled: Boolean(cron),
        cron,
        timezone: tzEnv && tzEnv.length > 0 ? tzEnv : "Europe/Berlin",
      },
    },
  }
}
