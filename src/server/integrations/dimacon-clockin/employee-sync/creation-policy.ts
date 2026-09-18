import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import { personnelNumberKey } from "./matcher.js"
import type { MatchOutcome } from "./matcher.js"
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

/**
 * Loser Namensschlüssel → Anzeigetext des ersten Treffers. Für die Anlage in
 * Dimacon über ALLE Dimacon-Mitarbeiter (auch archivierte — sie existieren
 * dort), für die Anlage in Clockin über die ungepaarten Clockin-Mitarbeiter.
 */
export function buildLooseNameIndex<T extends { firstName: string; lastName: string }>(
  people: readonly T[],
  label: (person: T) => string = (p) => `${p.firstName} ${p.lastName}`.trim(),
): Map<string, string> {
  const index = new Map<string, string>()
  for (const p of people) {
    const key = looseNameKey(p.firstName, p.lastName)
    if (!key || index.has(key)) continue
    index.set(key, label(p))
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

/**
 * Gegenstück für die Anlage Dimacon → Clockin. Ohne diesen Filter legte der
 * Lauf jeden ungepaarten aktiven Dimacon-Mitarbeiter an — auch Platzhalter
 * („Subunternehmer !"), Alt-Konten ohne Personalnummer und Personen, die in
 * Clockin nur unter abweichender oder fehlender Personalnummer stehen.
 */
export interface ClockinCreationPolicyInput {
  /** normalisierte Personalnummer → Clockin-Datensatz, der sie bereits trägt */
  clockinPersonnelNumbers: ReadonlyMap<string, string>
  /** normalisierte Personalnummern, die unter den Anlage-Kandidaten mehrfach vorkommen */
  duplicatePersonnelNumbers: ReadonlySet<string>
  /** loser Namensschlüssel → Clockin-Mitarbeiter OHNE Dimacon-Partner */
  unpairedClockinNames: ReadonlyMap<string, string>
}

export function buildClockinCreationPolicy(
  outcome: Pick<MatchOutcome, "dimaconOnly" | "clockinOnly">,
  clockinEmployees: readonly ClockinEmployeeInfo[],
): ClockinCreationPolicyInput {
  const clockinPersonnelNumbers = new Map<string, string>()
  for (const c of clockinEmployees) {
    const key = personnelNumberKey(c.personnelNumber)
    if (key && !clockinPersonnelNumbers.has(key))
      clockinPersonnelNumbers.set(key, describeClockin(c))
  }

  const seen = new Set<string>()
  const duplicatePersonnelNumbers = new Set<string>()
  for (const d of outcome.dimaconOnly) {
    const key = personnelNumberKey(d.personnelNumber)
    if (!key) continue
    if (seen.has(key)) duplicatePersonnelNumbers.add(key)
    else seen.add(key)
  }

  return {
    clockinPersonnelNumbers,
    duplicatePersonnelNumbers,
    unpairedClockinNames: buildLooseNameIndex(outcome.clockinOnly, describeClockin),
  }
}

/**
 * `null` = darf in Clockin angelegt werden, sonst der deutsche Grund für die
 * gemeldete `skipped`-Zeile. Der Name verknüpft hier nichts — er verhindert
 * nur eine Anlage, wenn dieselbe Person in Clockin unter anderer oder ohne
 * Personalnummer steht.
 */
export function clockinCreationBlockReason(
  d: DimaconEmployeeFull,
  p: ClockinCreationPolicyInput,
): string | null {
  if (!hasLetter(d.firstName) || !hasLetter(d.lastName)) {
    return "kein vollständiger Personenname in Dimacon (Platzhalter?)"
  }

  const similar = p.unpairedClockinNames.get(looseNameKey(d.firstName, d.lastName))
  const personnelNumber = d.personnelNumber?.trim()
  if (!personnelNumber) {
    return similar
      ? `keine Personalnummer in Dimacon — in Clockin steht ${similar}; Personalnummer in Dimacon pflegen`
      : "keine Personalnummer in Dimacon — ohne sie ist keine eindeutige Zuordnung möglich"
  }

  const key = personnelNumberKey(personnelNumber)
  const holder = p.clockinPersonnelNumbers.get(key)
  if (holder) {
    return `Personalnummer ${personnelNumber} ist in Clockin bereits vergeben (${holder})`
  }
  if (p.duplicatePersonnelNumbers.has(key)) {
    return `Personalnummer ${personnelNumber} ist in Dimacon mehrfach vergeben`
  }
  if (similar) {
    return `ähnlicher Name in Clockin vorhanden (${similar}) — Personalnummern abgleichen`
  }

  return null
}

function describeClockin(c: ClockinEmployeeInfo): string {
  const name = `${c.firstName} ${c.lastName}`.trim()
  const personnelNumber = c.personnelNumber?.trim()
  return `${name} #${c.id}, ${personnelNumber ? `PNr ${personnelNumber}` : "ohne PNr"}`
}

/** mindestens ein Buchstabe (beliebige Schrift) — „!" ist kein Name */
function hasLetter(value: string | undefined): boolean {
  return /\p{L}/u.test(value ?? "")
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
