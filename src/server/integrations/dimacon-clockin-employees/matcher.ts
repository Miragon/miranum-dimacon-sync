import type { DimaconEmployeeFull } from "../shared/dimacon.js"
import type { ClockinEmployeeInfo } from "./types.js"

export type MatchedBy = "personnelNumber" | "email" | "name"

export interface EmployeePair {
  dimacon: DimaconEmployeeFull
  clockin: ClockinEmployeeInfo
  matchedBy: MatchedBy
}

export interface AmbiguousEmployee {
  dimacon: DimaconEmployeeFull
  reason: string
}

export interface MatchOutcome {
  pairs: EmployeePair[]
  /** aktive Dimacon-Mitarbeiter ohne Clockin-Gegenstück → in Clockin anlegen */
  dimaconOnly: DimaconEmployeeFull[]
  /** Clockin-Mitarbeiter ohne Dimacon-Gegenstück → in Dimacon anlegen */
  clockinOnly: ClockinEmployeeInfo[]
  /** mehrdeutige Kandidaten — wird nie geraten, nur gemeldet */
  ambiguous: AmbiguousEmployee[]
}

/**
 * Matcht Dimacon- und Clockin-Mitarbeiter in drei Pässen pro Mitarbeiter:
 * Personalnummer → E-Mail → normalisierter Vor+Nachname. Ein Pass mit genau
 * einem Kandidaten matcht; mehrere Kandidaten gelten als mehrdeutig und
 * brechen ab (kein Fallthrough, um Fehlzuordnungen zu vermeiden). Archivierte
 * Dimacon-Mitarbeiter werden nie als Anlage-Kandidat geführt.
 */
export function matchEmployees(
  dimaconEmployees: DimaconEmployeeFull[],
  clockinEmployees: ClockinEmployeeInfo[],
): MatchOutcome {
  const byPersonnelNumber = index(clockinEmployees, (c) => norm(c.personnelNumber))
  const byEmail = index(clockinEmployees, (c) => norm(c.email))
  const byName = index(clockinEmployees, (c) => fullName(c.firstName, c.lastName))

  const used = new Set<number>()
  const pairs: EmployeePair[] = []
  const dimaconOnly: DimaconEmployeeFull[] = []
  const ambiguous: AmbiguousEmployee[] = []

  for (const d of dimaconEmployees) {
    const attempts: [string, Map<string, ClockinEmployeeInfo[]>, MatchedBy][] = [
      [norm(d.personnelNumber), byPersonnelNumber, "personnelNumber"],
      [norm(d.email), byEmail, "email"],
      [fullName(d.firstName, d.lastName), byName, "name"],
    ]

    let resolved = false
    for (const [key, map, matchedBy] of attempts) {
      if (!key) continue
      const candidates = (map.get(key) ?? []).filter((c) => !used.has(c.id))
      if (candidates.length === 0) continue
      if (candidates.length === 1) {
        pairs.push({ dimacon: d, clockin: candidates[0], matchedBy })
        used.add(candidates[0].id)
      } else {
        ambiguous.push({
          dimacon: d,
          reason: `${candidates.length} Clockin-Kandidaten über ${matchedBy}`,
        })
      }
      resolved = true
      break
    }

    if (!resolved && !d.isArchived) dimaconOnly.push(d)
  }

  return {
    pairs,
    dimaconOnly,
    clockinOnly: clockinEmployees.filter((c) => !used.has(c.id)),
    ambiguous,
  }
}

export interface PairDiff {
  /** Felder, die in Clockin auf den Dimacon-Stand gebracht werden müssen */
  clockinChanges: string[]
  /** Personalnummer, die nach Dimacon zurückgeschrieben werden soll */
  backfillPersonnelNumber?: string
}

/**
 * Dimacon gewinnt: Abweichungen der Match-Keys werden in Clockin korrigiert.
 * Einzige Rückschreibung nach Dimacon ist eine dort fehlende Personalnummer.
 * Alle weiteren Felder (Telefon etc.) laufen über die Feld-Zuordnung.
 */
export function diffPair(d: DimaconEmployeeFull, c: ClockinEmployeeInfo): PairDiff {
  const changes: string[] = []

  if (d.firstName.trim() !== (c.firstName ?? "").trim()) changes.push("firstName")
  if (d.lastName.trim() !== (c.lastName ?? "").trim()) changes.push("lastName")

  const dPn = norm(d.personnelNumber)
  const cPn = norm(c.personnelNumber)
  if (dPn && dPn !== cPn) changes.push("personnelNumber")

  return {
    clockinChanges: changes,
    backfillPersonnelNumber: !dPn && cPn ? c.personnelNumber?.trim() : undefined,
  }
}

function index<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    if (!k) continue
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}

function norm(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase()
}

function fullName(first: string | undefined, last: string | undefined): string {
  const name = `${norm(first)} ${norm(last)}`.trim()
  return name === "" ? "" : name.replace(/\s+/g, " ")
}
