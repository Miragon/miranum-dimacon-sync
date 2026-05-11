import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { log } from "./log.js"

export const SyncSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).default("Europe/Berlin"),
})

export type SyncSettings = z.infer<typeof SyncSettingsSchema>

const SettingsFileSchema = z.object({
  sync: SyncSettingsSchema,
})

export type SettingsFile = z.infer<typeof SettingsFileSchema>

const DEFAULT_PATH = "./data/settings.json"

function settingsPath(): string {
  return process.env.SETTINGS_PATH ?? DEFAULT_PATH
}

let cache: SettingsFile | undefined

export async function loadSettings(): Promise<SettingsFile> {
  if (cache) return cache
  const path = settingsPath()
  try {
    const raw = await readFile(path, "utf-8")
    cache = SettingsFileSchema.parse(JSON.parse(raw))
    return cache
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
}

export async function getSyncSettings(): Promise<SyncSettings> {
  return (await loadSettings()).sync
}

export async function updateSyncSettings(input: SyncSettings): Promise<SyncSettings> {
  const current = await loadSettings()
  const next: SettingsFile = { ...current, sync: input }
  await persist(next)
  cache = next
  return next.sync
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
    sync: {
      enabled: Boolean(cron),
      cron,
      timezone: tzEnv && tzEnv.length > 0 ? tzEnv : "Europe/Berlin",
    },
  }
}
