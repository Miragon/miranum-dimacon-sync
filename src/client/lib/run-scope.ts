/**
 * Single Source of Truth für den „Umfang" einer Integration im Client —
 * gleiche Konvention wie die FORMS-Map in RunForm: Integrationen ohne
 * Eintrag haben keinen konfigurierbaren Umfang (kein Umfang-Tab, keine
 * Vorbelegung). Die Labels/Hinweise stehen genau einmal hier und werden
 * vom Run-Formular, vom Umfang-Tab und von der Run-Historie genutzt.
 *
 * Die `default`-Werte spiegeln die Zod-Defaults des jeweiligen
 * `inputSchema` auf dem Server — insbesondere sind `employeeCreateInDimacon`
 * (Issue #17) und `importFromLexware` bewusst AUS. Ein fehlender Key darf nie
 * zu „an" werden.
 */
export interface RunStepSpec {
  key: string
  label: string
  /**
   * Schema-Default des Servers — und zugleich der Marker für Opt-in-Schritte:
   * `false` heißt „aus ist der Normalfall". Solche Schritte zählt
   * `describeStepCount` weder in den Zähler noch in den Nenner.
   */
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
      {
        key: "employees",
        label: "Mitarbeiter-Abgleich (⇄ Stammdaten)",
        default: true,
        note:
          "Zugeordnet wird ausschließlich über die Personalnummer. In Clockin angelegt werden nur aktive " +
          "Dimacon-Mitarbeiter mit vollständigem Namen und einer Personalnummer, die dort noch nicht vergeben ist — " +
          "und nur, wenn in Clockin kein namensähnlicher Mitarbeiter ohne passende Personalnummer existiert. Alle " +
          "übersprungenen Kandidaten stehen mit Begründung im Ergebnis.",
      },
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
      {
        key: "assignments",
        label: "Mitarbeiter-Zuordnung",
        default: true,
        note:
          "Eingeplante Mitarbeiter werden über ihre Personalnummer in Clockin gefunden — ohne Personalnummer " +
          "in Dimacon bleibt ein Mitarbeiter unzugeordnet und steht als Fehler im Ergebnis.",
      },
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
      {
        key: "importFromLexware",
        label: "Kunden aus Lexware in Dimacon anlegen",
        default: false,
        note:
          "Übernommen werden nur Lexware-Kunden mit einem Angebot oder einer Auftragsbestätigung der letzten 14 " +
          "Tage (abgelehnte und stornierte Belege zählen nicht). Angelegt wird mit der Lexware-Kundennummer — und " +
          "nur, wenn die Nummer in Dimacon frei ist und dort kein gleich oder ähnlich benannter Kunde existiert. " +
          "Alle übersprungenen Kontakte stehen mit Begründung im Ergebnis.",
      },
    ],
    hints: (steps) =>
      [
        steps.createContacts
          ? "Läuft über den gesamten Dimacon-Kundenbestand — ein Live-Lauf legt fehlende Lexware-Kontakte an."
          : "Nur Abgleich — es werden keine Lexware-Kontakte angelegt.",
        steps.importFromLexware &&
          "Ein Live-Lauf legt jetzt auch in Dimacon Kunden an — siehe die Bedingungen unter den Schritten.",
      ].filter((h): h is string => Boolean(h)),
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

/**
 * Einen Schritt umschalten und dabei die `requires`-Kette mitführen: wird ein
 * Basisschritt abgewählt, gehen alle Schritte mit aus, die nur zusätzlich zu
 * ihm greifen. Ohne das bliebe ein Opt-in wie `employeeCreateInDimacon` auf
 * „an" stehen, obwohl die UI ihn nur noch ausgegraut zeigt. Beim EINschalten
 * bleibt der Opt-in bewusst aus: „an" ist immer eine bewusste Einzelentscheidung.
 *
 * Der eigentliche Schutz gegen das ungefragte Wiederscharfschalten sitzt
 * serverseitig (`normalizeSyncSteps` im inputSchema) — hier geht es darum,
 * dass die UI gar nicht erst einen Zustand schreibt, den sie selbst nur
 * ausgegraut anzeigt.
 */
export function toggleStep(
  integrationId: string,
  steps: Record<string, boolean>,
  key: string,
  value: boolean,
): Record<string, boolean> {
  const next = { ...steps, [key]: value }
  const spec = RUN_SCOPE_SPECS[integrationId]
  if (value || !spec) return next
  // Fixpunkt statt einem Durchlauf: ein abhängiger Schritt darf selbst Basis
  // weiterer Schritte sein, unabhängig von der Reihenfolge in `spec.steps`.
  let changed = true
  while (changed) {
    changed = false
    for (const step of spec.steps) {
      if (step.requires && !next[step.requires] && next[step.key]) {
        next[step.key] = false
        changed = true
      }
    }
  }
  return next
}

/** true, wenn der gespeicherte Umfang exakt den Schema-Defaults entspricht. */
export function isDefaultScope(integrationId: string, runDefaults: unknown): boolean {
  const spec = RUN_SCOPE_SPECS[integrationId]
  if (!spec) return true
  const scope = readScope(integrationId, runDefaults, { dryRunFallback: false })
  if (scope.dryRun) return false
  return spec.steps.every((step) => scope.steps[step.key] === step.default)
}

/**
 * „voll", „3 von 5 Schritten" — und, falls ein Opt-in-Schritt an ist,
 * zusätzlich „+ 1 Zusatzschritt".
 *
 * Opt-in-Schritte (Schema-Default `false`) stehen bewusst WEDER im Zähler NOCH
 * im Nenner: „aus" ist ihr dokumentierter Normalfall (Issue #17) — sonst läse
 * der unveränderte Umfang als eingeschränkt und widerspräche `isDefaultScope`
 * und den Badges aus step-badges.ts. Eingeschaltet werden sie separat
 * ausgewiesen; ein zusätzlich schreibender Schritt darf nie hinter „voll"
 * verschwinden.
 *
 * Für Integrationen MIT Spec gilt danach: `describeScope(x) === "voll · live"`
 * genau dann, wenn `isDefaultScope(x)` true ist.
 */
export function describeStepCount(spec: RunScopeSpec, steps: Record<string, boolean>): string {
  const core = spec.steps.filter((step) => step.default)
  const active = core.filter((step) => steps[step.key]).length
  // Ein Opt-in ohne seinen `requires`-Schritt führt der Server nicht aus
  // (dimacon-clockin/run.ts: `steps.employees ? … createInDimacon …`) — und
  // `hints` meldet ihn genau deshalb auch nur zusammen mit `employees`. Sonst
  // behauptet das Label einen Schreib-Schritt, den kein Lauf ausführt
  // (Altdaten bzw. API-PUT).
  const optIn = spec.steps.filter(
    (step) => !step.default && steps[step.key] && (!step.requires || steps[step.requires]),
  ).length
  const base = active === core.length ? "voll" : `${active} von ${core.length} Schritten`
  return optIn === 0 ? base : `${base} + ${optIn} Zusatzschritt${optIn === 1 ? "" : "e"}`
}

/** Kurzlabel wie „voll · live" oder „3 von 5 Schritten · dry-run". */
export function describeScope(integrationId: string, runDefaults: unknown): string {
  const spec = RUN_SCOPE_SPECS[integrationId]
  if (!spec) return "—"
  const scope = readScope(integrationId, runDefaults, { dryRunFallback: false })
  return `${describeStepCount(spec, scope.steps)} · ${scope.dryRun ? "dry-run" : "live"}`
}
