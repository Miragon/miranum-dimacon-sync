import { readFile } from "node:fs/promises"
import { z } from "zod"
import { EntityFieldMappingSchema } from "../integrations/shared/field-mapping-schema.js"
import { ScheduleSettingsSchema } from "./schedule-schema.js"

/**
 * Read-only-Parser für die alte settings.json (SETTINGS_PATH). Einziger
 * Konsument ist der einmalige Legacy-Seed (db/seed-legacy.ts) — hier wird
 * nichts mehr geschrieben, gecacht oder migriert-persistiert; die Datei
 * bleibt als Rollback-Pfad unangetastet auf dem Volume.
 */

const FieldMappingsSchema = z
  .record(z.string(), z.record(z.string(), EntityFieldMappingSchema))
  .default({})

const SettingsFileSchema = z.object({
  integrations: z.record(z.string(), ScheduleSettingsSchema),
  fieldMappings: FieldMappingsSchema,
})

/** Älteste Dateiform (eine einzige Sync-Konfiguration). */
const LegacyFileSchema = z.object({
  sync: ScheduleSettingsSchema,
})

export type SettingsFile = z.infer<typeof SettingsFileSchema>

const DEFAULT_PATH = "./data/settings.json"
const LEGACY_INTEGRATION_ID = "dimacon-clockin"
// "dimacon-clockin-employees" wurde in "dimacon-clockin" gefaltet.
const REMOVED_EMPLOYEES_ID = "dimacon-clockin-employees"

export function settingsPath(): string {
  return process.env.SETTINGS_PATH ?? DEFAULT_PATH
}

/** Pure Variante der beiden Alt-Migrationen — parst, schreibt nie zurück. */
export function parseSettingsFile(raw: unknown): SettingsFile {
  const modern = SettingsFileSchema.safeParse(raw)
  if (modern.success) return foldRemovedEmployeesIntegration(modern.data)

  const legacy = LegacyFileSchema.safeParse(raw)
  if (legacy.success) {
    return {
      integrations: { [LEGACY_INTEGRATION_ID]: legacy.data.sync },
      fieldMappings: {},
    }
  }

  throw new Error("settings file has an unrecognized shape")
}

function foldRemovedEmployeesIntegration(file: SettingsFile): SettingsFile {
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

  return { integrations, fieldMappings }
}

/** Liest + parst die Datei; fehlende Datei ⇒ undefined (kein Fehler). */
export async function loadLegacySettingsFile(): Promise<SettingsFile | undefined> {
  let raw: string
  try {
    raw = await readFile(settingsPath(), "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
  return parseSettingsFile(JSON.parse(raw) as unknown)
}
