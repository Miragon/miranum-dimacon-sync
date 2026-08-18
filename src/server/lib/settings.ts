import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { EntityFieldMappingSchema } from "../integrations/shared/field-mapping-schema.js"
import type { EntityFieldMapping } from "../integrations/shared/field-mapping-schema.js"
import { log } from "./log.js"

export const ScheduleSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).default("Europe/Berlin"),
})

export type ScheduleSettings = z.infer<typeof ScheduleSettingsSchema>

// Feld-Zuordnungen, keyed nach Integration-ID → Entity ("project" etc.).
// Muss im Datei-Schema deklariert sein — Zod strippt unbekannte Keys beim Laden.
const FieldMappingsSchema = z
  .record(z.string(), z.record(z.string(), EntityFieldMappingSchema))
  .default({})

const SettingsFileSchema = z.object({
  integrations: z.record(z.string(), ScheduleSettingsSchema),
  fieldMappings: FieldMappingsSchema,
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
let loading: Promise<SettingsFile> | undefined

/**
 * Single-Flight: parallele Erst-Loads (z. B. mehrere Requests direkt nach
 * dem Boot) teilen sich EIN Laden — sonst seeden/migrieren zwei Loads
 * gleichzeitig und konkurrieren um dieselbe tmp-Datei beim Persist.
 */
export async function loadSettings(): Promise<SettingsFile> {
  if (cache) return cache
  if (!loading) {
    loading = doLoadSettings().then(
      (file) => {
        cache = file
        loading = undefined
        return file
      },
      (err: unknown) => {
        loading = undefined
        throw err
      },
    )
  }
  return loading
}

async function doLoadSettings(): Promise<SettingsFile> {
  const path = settingsPath()

  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      const seeded = seedFromEnv()
      await persist(seeded)
      log.info("settings file seeded", { path, source: "env" })
      return seeded
    }
    throw err
  }

  const parsed: unknown = JSON.parse(raw)

  const modern = SettingsFileSchema.safeParse(parsed)
  if (modern.success) {
    return migrateRemovedEmployeesIntegration(modern.data, path)
  }

  const legacy = LegacyFileSchema.safeParse(parsed)
  if (legacy.success) {
    const migrated: SettingsFile = {
      integrations: { [LEGACY_INTEGRATION_ID]: legacy.data.sync },
      fieldMappings: {},
    }
    await persist(migrated)
    log.info("settings file migrated from legacy shape", { path })
    return migrated
  }

  throw new Error(`settings file at ${path} has an unrecognized shape`)
}

// Die Integration "dimacon-clockin-employees" wurde in "dimacon-clockin"
// gefaltet (Mitarbeiter-Abgleich ist jetzt ein Schritt): ihre persistierte
// Feld-Zuordnung wandert mit, der eigene Cron-Slot entfällt.
const REMOVED_EMPLOYEES_ID = "dimacon-clockin-employees"

async function migrateRemovedEmployeesIntegration(
  file: SettingsFile,
  path: string,
): Promise<SettingsFile> {
  const hasSchedule = REMOVED_EMPLOYEES_ID in file.integrations
  const hasMappings = REMOVED_EMPLOYEES_ID in file.fieldMappings
  if (!hasSchedule && !hasMappings) return file

  const integrations = { ...file.integrations }
  delete integrations[REMOVED_EMPLOYEES_ID]

  const fieldMappings = { ...file.fieldMappings }
  const removed = fieldMappings[REMOVED_EMPLOYEES_ID]
  delete fieldMappings[REMOVED_EMPLOYEES_ID]
  if (removed?.employee) {
    fieldMappings[LEGACY_INTEGRATION_ID] = {
      // Ein bestehender employee-Eintrag unter dimacon-clockin gewinnt
      ...{ employee: removed.employee },
      ...(fieldMappings[LEGACY_INTEGRATION_ID] ?? {}),
    }
  }

  const next: SettingsFile = { integrations, fieldMappings }
  await persist(next)
  log.info("settings migrated: folded dimacon-clockin-employees into dimacon-clockin", { path })
  return next
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

export async function getFieldMapping(
  integrationId: string,
  entity: string,
): Promise<EntityFieldMapping | undefined> {
  const file = await loadSettings()
  return file.fieldMappings[integrationId]?.[entity]
}

/** `null` löscht die Zuordnung (zurück auf Default) und räumt leere Objekte weg. */
export async function updateFieldMapping(
  integrationId: string,
  entity: string,
  mapping: EntityFieldMapping | null,
): Promise<void> {
  const task = writeChain.then(async () => {
    const current = await loadSettings()
    const forIntegration = { ...(current.fieldMappings[integrationId] ?? {}) }
    if (mapping === null) delete forIntegration[entity]
    else forIntegration[entity] = mapping

    const fieldMappings = { ...current.fieldMappings }
    if (Object.keys(forIntegration).length === 0) delete fieldMappings[integrationId]
    else fieldMappings[integrationId] = forIntegration

    const next: SettingsFile = { ...current, fieldMappings }
    await persist(next)
    cache = next
  })
  writeChain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

let tmpCounter = 0

async function persist(data: SettingsFile): Promise<void> {
  const path = settingsPath()
  await mkdir(dirname(path), { recursive: true })
  // Eindeutiger tmp-Name: parallele Persists (zweiter Prozess, Tests) dürfen
  // sich nicht gegenseitig die tmp-Datei unterm Rename wegziehen.
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8")
  // Windows: rename liefert transient EPERM/EBUSY (Virenscanner, parallele
  // Handles) — kurz erneut versuchen statt hart zu scheitern.
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 3 || (code !== "EPERM" && code !== "EBUSY")) throw err
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
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
    fieldMappings: {},
  }
}
