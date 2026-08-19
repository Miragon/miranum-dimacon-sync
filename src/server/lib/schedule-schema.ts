import { z } from "zod"

export const ScheduleSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).default("Europe/Berlin"),
})

export type ScheduleSettings = z.infer<typeof ScheduleSettingsSchema>

export const DEFAULT_SCHEDULE: ScheduleSettings = {
  enabled: false,
  timezone: "Europe/Berlin",
}
