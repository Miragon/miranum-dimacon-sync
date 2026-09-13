/** Badge-Auswahl für die Schritt-Schalter des dimacon-clockin-Ergebnisses. */
export interface StepBadge {
  key: string
  label: string
  variant: "default" | "warn"
}

const STEP_LABELS: Record<string, string> = {
  employees: "mitarbeiter-abgleich",
  customers: "kunden",
  projects: "projekte",
  assignments: "zuordnung",
  archive: "archivierung",
}

/**
 * Opt-in-Schalter sind KEINE abschaltbaren Schritte: „aus“ ist der
 * dokumentierte Normalfall (Issue #17) und darf deshalb keine Warn-Badge in
 * Akzent-Rot erzeugen. Gemeldet wird nur der eingeschaltete Zustand, neutral.
 */
const OPT_IN_LABELS: Record<string, string> = {
  employeeCreateInDimacon: "anlage dimacon an",
}

/**
 * Abgeschaltete Schritte als Warnung, eingeschaltete Opt-ins als neutraler
 * Hinweis. Unbekannte Schlüssel (ältere/neuere Server-Versionen) laufen als
 * abschaltbarer Schritt mit ihrem Rohnamen mit.
 */
export function stepBadges(steps: Record<string, boolean | undefined> | undefined): StepBadge[] {
  if (!steps) return []
  const badges: StepBadge[] = []
  for (const [key, on] of Object.entries(steps)) {
    const optIn = OPT_IN_LABELS[key]
    if (optIn !== undefined) {
      if (on) badges.push({ key, label: optIn, variant: "default" })
      continue
    }
    if (!on) badges.push({ key, label: `${STEP_LABELS[key] ?? key} aus`, variant: "warn" })
  }
  return badges
}
