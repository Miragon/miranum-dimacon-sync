import { defineIntegration } from "../types.js"
import { runDimaconLexofficeSync } from "./run.js"
import { CustomerSyncInputSchema } from "./types.js"

export const dimaconLexofficeIntegration = defineIntegration({
  id: "dimacon-lexoffice",
  name: "Dimacon ⇄ Lexoffice",
  description:
    "Alle Dimacon-Kunden mit Lexware Office abgleichen — fehlende Kontakte " +
    "anlegen und Dimacon-Kundennummern an die Lexware-Nummern angleichen. " +
    "Optional: Kunden mit aktuellem Angebot oder Auftragsbestätigung aus " +
    "Lexware in Dimacon anlegen.",
  systems: ["dimacon", "lexoffice"],
  requiredCredentials: ["dimacon", "lexoffice"],
  inputSchema: CustomerSyncInputSchema,
  run: runDimaconLexofficeSync,
})
