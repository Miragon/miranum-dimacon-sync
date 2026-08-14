import { defineIntegration } from "../types.js"
import { runDimaconClockinEmployeeSync } from "./run.js"
import { EmployeeSyncInputSchema } from "./types.js"

export const dimaconClockinEmployeesIntegration = defineIntegration({
  id: "dimacon-clockin-employees",
  name: "Dimacon ⇄ Clockin · Mitarbeiter",
  description:
    "Mitarbeiter bidirektional abgleichen — fehlende Mitarbeiter auf beiden " +
    "Seiten anlegen, bei Abweichungen gewinnt Dimacon, Archivierungen werden " +
    "nur gemeldet.",
  systems: ["dimacon", "clockin"],
  requiredEnv: ["DIMACON_BASE_URL", "DIMACON_TENANT", "DIMACON_API_TOKEN", "CLOCKIN_API_TOKEN"],
  inputSchema: EmployeeSyncInputSchema,
  run: runDimaconClockinEmployeeSync,
})
