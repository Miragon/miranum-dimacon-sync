import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import type { ClockinEmployeeInfo } from "./types.js"

/**
 * Relevanzfilter für die Anlage Clockin → Dimacon (Issue #17). Rein
 * funktional: keine SDK-, DB- oder Env-Zugriffe, das Datum kommt als
 * Parameter. Die Anlage ist der einzige Schritt, der aus einem
 * Clockin-Datensatz einen neuen Dimacon-Mitarbeiter macht — jeder Zweifel
 * führt zu einer gemeldeten Zeile statt zu einer stillen Anlage.
 */
export interface CreationPolicyInput {
  /** Schalter `steps.employeeCreateInDimacon` — per Default aus */
  enabled: boolean
  /** false ⇒ Clockin-Bestand unvollständig geladen (Matching unzuverlässig) */
  baseComplete: boolean
  /** Clockin-ID → Grund aus dem Matcher (mehrdeutig / Dublette) */
  blocked: ReadonlyMap<number, string>
  /** loser Namensschlüssel → „Vorname Nachname“ des Dimacon-Treffers */
  looseNames: ReadonlyMap<string, string>
  /** heutiges Datum als YYYY-MM-DD */
  today: string
}

export const CREATION_DISABLED_REASON =
  "Anlage in Dimacon deaktiviert (Schritt „Mitarbeiter in Dimacon anlegen“)"

export const INCOMPLETE_BASE_REASON = "Clockin-Bestand unvollständig geladen — keine Anlage"

/**
 * Loser Namensschlüssel für die Ähnlichkeitsprüfung: erster Vorname +
 * letzter Nachname, ohne Diakritika, Bindestriche und Zweitnamen. Fängt
 * „Hans-Peter“ vs. „Hans Peter“, einen zweiten Vornamen in nur einem System
 * und Umlaut-Schreibweisen („Müller“/„Mueller“).
 */
export function looseNameKey(first: string | undefined, last: string | undefined): string {
  const firstTokens = tokens(first)
  const lastTokens = tokens(last)
  if (firstTokens.length === 0 || lastTokens.length === 0) return ""
  return `${firstTokens[0]} ${lastTokens[lastTokens.length - 1]}`
}

/** Index über alle Dimacon-Mitarbeiter (auch archivierte — sie existieren dort). */
export function buildLooseNameIndex(
  dimaconEmployees: readonly DimaconEmployeeFull[],
): Map<string, string> {
  const index = new Map<string, string>()
  for (const e of dimaconEmployees) {
    const key = looseNameKey(e.firstName, e.lastName)
    if (!key || index.has(key)) continue
    index.set(key, `${e.firstName} ${e.lastName}`.trim())
  }
  return index
}

/**
 * `null` = darf in Dimacon angelegt werden, sonst der deutsche Grund für die
 * gemeldete `skipped`-Zeile. Reihenfolge ist bewusst fix: globale Gründe
 * (Schalter, unvollständige Basis) schlagen alle datensatzbezogenen.
 */
export function creationBlockReason(c: ClockinEmployeeInfo, p: CreationPolicyInput): string | null {
  if (!p.enabled) return CREATION_DISABLED_REASON
  if (!p.baseComplete) return INCOMPLETE_BASE_REASON

  const blocked = p.blocked.get(c.id)
  if (blocked) return blocked

  if (!c.firstName?.trim() || !c.lastName?.trim()) return "unvollständiger Name in Clockin"

  if (!c.personnelNumber?.trim()) {
    return "keine Personalnummer in Clockin — Zuordnung nicht eindeutig"
  }

  const contractEnding = (c.contractEnding ?? "").slice(0, 10)
  if (contractEnding && contractEnding < p.today) {
    return `Vertrag endete am ${contractEnding}`
  }

  const similar = p.looseNames.get(looseNameKey(c.firstName, c.lastName))
  if (similar) {
    return `ähnlicher Name in Dimacon vorhanden (${similar}) — bitte manuell prüfen`
  }

  return null
}

/** klein, ohne Diakritika, Umlaute ausgeschrieben, nur Buchstaben-Tokens */
function tokens(value: string | undefined): string[] {
  return (value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "")
}
