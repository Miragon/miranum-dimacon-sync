import { defineIntegration } from "../types.js"
import { runDimaconLexofficeSync } from "./run.js"
import { CustomerSyncInputSchema } from "./types.js"

export const dimaconLexofficeIntegration = defineIntegration({
  id: "dimacon-lexoffice",
  name: "Dimacon → Lexoffice",
  description:
    "Alle Dimacon-Kunden mit Lexware Office abgleichen — fehlende Kontakte " +
    "anlegen und Dimacon-Kundennummern an die Lexware-Nummern angleichen.",
  systems: ["dimacon", "lexoffice"],
  requiredEnv: [
    "DIMACON_BASE_URL",
    "DIMACON_TENANT",
    "DIMACON_API_TOKEN",
    "LEXWARE_OFFICE_API_KEY",
  ],
  inputSchema: CustomerSyncInputSchema,
  run: runDimaconLexofficeSync,
})
