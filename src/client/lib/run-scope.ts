/**
 * Single Source of Truth für den „Umfang" einer Integration im Client —
 * gleiche Konvention wie die FORMS-Map in RunForm: Integrationen ohne
 * Eintrag haben keinen konfigurierbaren Umfang (kein Umfang-Tab, keine
 * Vorbelegung). Die Labels/Hinweise stehen genau einmal hier und werden
 * vom Run-Formular, vom Umfang-Tab und von der Run-Historie genutzt.
 *
 * Die `default`-Werte spiegeln die Zod-Defaults des jeweiligen
 * `inputSchema` auf dem Server — insbesondere ist `employeeCreateInDimacon`
 * bewusst AUS (Issue #17). Ein fehlender Key darf nie zu „an" werden.
 */
export interface RunStepSpec {
  key: string
  label: string
  default: boolean
  /** Schritt greift nur zusätzlich zu diesem Schritt (UI: disabled). */
  requires?: string
  /**
   * Dauerhaft geltende Einschränkung des Schritts — wird IMMER angezeigt, auch
   * wenn der Schritt gerade aus ist. Wer entscheidet, ob er einen Schritt
   * einschaltet, muss dessen Regeln vorher sehen; ein Filter, den man erst nach
   * dem Einschalten erklärt bekommt, wirkt im Ergebnis wie ein Fehler.
   */
  note?: string
}

export interface RunScopeSpec {
  steps: RunStepSpec[]
  /** Warnhinweise zur aktuellen Auswahl — alle zutreffenden, nie gekürzt. */
  hints(steps: Record<string, boolean>): string[]
}

export interface RunScope {
  dryRun: boolean
  steps: Record<string, boolean>
}

export const RUN_SCOPE_SPECS: Record<string, RunScopeSpec> = {
  "dimacon-clockin": {
    steps: [
      { key: "employees", label: "Mitarbeiter-Abgleich (⇄ Stammdaten)", default: true },
      {
        key: "employeeCreateInDimacon",
        label: "Mitarbeiter in Dimacon anlegen",
        default: false,
        requires: "employees",
        note:
          "Übernommen werden nur Clockin-Mitarbeiter mit Personalnummer, vollständigem Namen und ohne beendeten Vertrag — " +
          "und nur, wenn in Dimacon kein namensähnlicher Mitarbeiter existiert und der Datensatz in Clockin nicht doppelt " +
          "oder mehrdeutig ist. Angelegt wird mit Rolle CRAFTSMAN und OHNE Team (in Dimacon danach zuweisen). Alle " +
          "übersprungenen Kandidaten stehen mit Begründung im Ergebnis.",
      },
      { key: "customers", label: "Kunden anlegen", default: true },
      { key: "projects", label: "Projekte anlegen/aktualisieren", default: true },
      { key: "assignments", label: "Mitarbeiter-Zuordnung", default: true },
      {
        key: "archive",
        label: "Archivierung",
        default: true,
        note:
          "Archiviert Clockin-Projekte, die im Planungshorizont von ±14 Tagen um heute und um das Sync-Datum " +
          "keinen Termin haben (anpassbar über ARCHIVE_HORIZON_DAYS). Projekte ohne Dimacon-Nummer bleiben " +
          "unberührt. Konnte der Horizont oder die Projektliste nicht vollständig geladen werden, wird nichts " +
          "archiviert und der Grund steht im Ergebnis.",
      },
    ],
    hints: (steps) =>
      [
        steps.employees &&
          "Der Mitarbeiter-Abgleich läuft über den gesamten Bestand beider Systeme — ein Live-Lauf legt in Clockin fehlende Mitarbeiter dort an.",
        steps.employees &&
          steps.employeeCreateInDimacon &&
          "Ein Live-Lauf legt jetzt auch in Dimacon Mitarbeiter an — siehe die Bedingungen unter den Schritten.",
        !steps.projects &&
          "Es werden keine Projekte angelegt oder aktualisiert — nur Abgleich/Zuordnung/Archivierung.",
        !steps.customers &&
          steps.projects &&
          "Neue Projekte ohne vorhandenen Clockin-Kunden werden übersprungen.",
      ].filter((h): h is string => Boolean(h)),
  },
  "dimacon-lexoffice": {
    steps: [
      {
        key: "createContacts",
        label: "Lexware-Kontakte anlegen",
        default: true,
        note:
          "Angelegt wird nur, wenn der Kunde in Lexware eindeutig NICHT existiert. Mehrere gleichnamige Treffer, " +
          "gleichnamige Dimacon-Kunden im selben Lauf und Kundennummern, die in Lexware zu einem anderen Namen " +
          "gehören, werden mit Begründung gemeldet statt geschrieben.",
      },
      { key: "alignNumbers", label: "Kundennummern angleichen", default: true },
    ],
    hints: (steps) => [
      steps.createContacts
        ? "Läuft über den gesamten Dimacon-Kundenbestand — ein Live-Lauf legt fehlende Lexware-Kontakte an."
        : "Nur Abgleich — es werden keine Lexware-Kontakte angelegt.",
    ],
  },
}

function stepsOf(runDefaults: unknown): Record<string, unknown> {
  if (typeof runDefaults !== "object" || runDefaults === null) return {}
  const steps = (runDefaults as { steps?: unknown }).steps
  return typeof steps === "object" && steps !== null ? (steps as Record<string, unknown>) : {}
}

/**
 * Gespeicherten (oder von einem Lauf protokollierten) Umfang in den
 * UI-Zustand übersetzen. Fehlende Step-Keys fallen auf den Schema-Default
 * des Schritts zurück, `dryRun` auf `dryRunFallback` — im Run-Formular
 * `true` (nie ungefragt live starten), im Umfang-Tab `false` (so
 * interpretiert der Server einen leeren Umfang).
 */
export function readScope(
  integrationId: string,
  runDefaults: unknown,
  { dryRunFallback }: { dryRunFallback: boolean },
): RunScope {
  const spec = RUN_SCOPE_SPECS[integrationId]
  const stored = typeof runDefaults === "object" && runDefaults !== null ? runDefaults : {}
  const dryRun = (stored as { dryRun?: unknown }).dryRun
  const rawSteps = stepsOf(stored)
  const steps: Record<string, boolean> = {}
  for (const step of spec?.steps ?? []) {
    const stored = rawSteps[step.key]
    steps[step.key] = typeof stored === "boolean" ? stored : step.default
  }
  return { dryRun: typeof dryRun === "boolean" ? dryRun : dryRunFallback, steps }
}

/** UI-Zustand → Persistenz-Form. Enthält nie ein Datum (Cron = immer heute). */
export function toRunDefaults(scope: RunScope): Record<string, unknown> {
  return { dryRun: scope.dryRun, steps: { ...scope.steps } }
}

/** true, wenn der gespeicherte Umfang exakt den Schema-Defaults entspricht. */
export function isDefaultScope(integrationId: string, runDefaults: unknown): boolean {
  const spec = RUN_SCOPE_SPECS[integrationId]
  if (!spec) return true
  const scope = readScope(integrationId, runDefaults, { dryRunFallback: false })
  if (scope.dryRun) return false
  return spec.steps.every((step) => scope.steps[step.key] === step.default)
}

/** Kurzlabel wie „voll · live" oder „3 von 6 Schritten · dry-run". */
export function describeScope(integrationId: string, runDefaults: unknown): string {
  const spec = RUN_SCOPE_SPECS[integrationId]
  if (!spec) return "—"
  const scope = readScope(integrationId, runDefaults, { dryRunFallback: false })
  const active = spec.steps.filter((step) => scope.steps[step.key]).length
  const scopeLabel =
    active === spec.steps.length ? "voll" : `${active} von ${spec.steps.length} Schritten`
  return `${scopeLabel} · ${scope.dryRun ? "dry-run" : "live"}`
}
