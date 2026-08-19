import { defineIntegration } from "../types.js"
import { runDimaconClockinSync } from "./run.js"
import { SyncRunInputSchema } from "./types.js"

export const dimaconClockinIntegration = defineIntegration({
  id: "dimacon-clockin",
  name: "Dimacon ⇄ Clockin",
  description:
    "Kompletter Clockin-Sync mit zuschaltbaren Schritten — Mitarbeiter-Stammdaten " +
    "bidirektional abgleichen, dann Tagesplanung: Kunden/Projekte upserten, " +
    "Mitarbeiter zuweisen, nicht Eingeplante archivieren.",
  systems: ["dimacon", "clockin"],
  requiredCredentials: ["dimacon", "clockin"],
  inputSchema: SyncRunInputSchema,
  run: runDimaconClockinSync,
})
