import { defineIntegration } from "../types.js"
import { runDimaconClockinSync } from "./run.js"
import { SyncRunInputSchema } from "./types.js"

export const dimaconClockinIntegration = defineIntegration({
  id: "dimacon-clockin",
  name: "Dimacon → Clockin",
  description:
    "Tagesplanung aus Dimacon nach Clockin übertragen — Termine laden, Projekte upserten, " +
    "Mitarbeiter zuweisen, nicht Eingeplante archivieren.",
  systems: ["dimacon", "clockin"],
  requiredEnv: ["DIMACON_BASE_URL", "DIMACON_TENANT", "DIMACON_API_TOKEN", "CLOCKIN_API_TOKEN"],
  inputSchema: SyncRunInputSchema,
  run: runDimaconClockinSync,
})
