import { defineIntegration } from "../types.js"
import { runDimaconSevdeskSync } from "./run.js"
import { CustomerSyncInputSchema } from "./types.js"

export const dimaconSevdeskIntegration = defineIntegration({
  id: "dimacon-sevdesk",
  name: "Dimacon → sevDesk",
  description:
    "Alle Dimacon-Kunden mit sevDesk abgleichen — fehlende Kontakte anlegen und " +
    "Dimacon-Kundennummern an die sevDesk-Nummern angleichen.",
  systems: ["dimacon", "sevdesk"],
  requiredCredentials: ["dimacon", "sevdesk"],
  inputSchema: CustomerSyncInputSchema,
  run: runDimaconSevdeskSync,
})
