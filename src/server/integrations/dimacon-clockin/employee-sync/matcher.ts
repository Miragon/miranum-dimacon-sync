import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import type { ClockinEmployeeInfo } from "./types.js"

export interface EmployeePair {
  dimacon: DimaconEmployeeFull
  clockin: ClockinEmployeeInfo
}

export interface AmbiguousEmployee {
  dimacon: DimaconEmployeeFull
  reason: string
}

export interface MatchOutcome {
  pairs: EmployeePair[]
  /** aktive Dimacon-Mitarbeiter ohne Clockin-Gegenstück → Kandidaten für die Anlage in Clockin */
  dimaconOnly: DimaconEmployeeFull[]
  /** Clockin-Mitarbeiter ohne Dimacon-Gegenstück → in Dimacon anlegen */
  clockinOnly: ClockinEmployeeInfo[]
  /** mehrdeutige Kandidaten — wird nie geraten, nur gemeldet */
  ambiguous: AmbiguousEmployee[]
  /**
   * Clockin-IDs, die NIE Anlage-Kandidat in Dimacon sein dürfen (mehrdeutige
   * Zuordnung oder Dublette — zu einem bereits gematchten ODER zu einem
   * anderen ungematchten Clockin-Datensatz) → deutscher Grund. Sie bleiben in
   * `clockinOnly`; die Anlage-Policy filtert sie.
   */
  blockedClockinIds: Map<number, string>
}

/**
 * Matcht Dimacon- und Clockin-Mitarbeiter AUSSCHLIESSLICH über die
 * Personalnummer. Name und E-Mail sind als Schlüssel ungeeignet: ein
 * archivierter Alt-Datensatz ohne Personalnummer schnappte sich früher über
 * den Namen den Clockin-Mitarbeiter, und der aktive Datensatz derselben
 * Person sollte daraufhin ein zweites Mal in Clockin angelegt werden. Namen
 * dienen nur noch als Bremse VOR einer Anlage (`creation-policy.ts`) — sie
 * verknüpfen nie etwas.
 *
 * Aktive Dimacon-Mitarbeiter matchen VOR archivierten: trägt ein archivierter
 * Datensatz dieselbe Personalnummer (Wiedereinstellung), gewinnt der aktive.
 * Mehrere Clockin-Kandidaten gelten als mehrdeutig und werden nur gemeldet.
 * Archivierte Dimacon-Mitarbeiter werden nie als Anlage-Kandidat geführt.
 */
export function matchEmployees(
  dimaconEmployees: DimaconEmployeeFull[],
  clockinEmployees: ClockinEmployeeInfo[],
): MatchOutcome {
  const byPersonnelNumber = index(clockinEmployees, (c) => personnelNumberKey(c.personnelNumber))

  const used = new Set<number>()
  const pairs: EmployeePair[] = []
  const dimaconOnly: DimaconEmployeeFull[] = []
  const ambiguous: AmbiguousEmployee[] = []
  const blockedClockinIds = new Map<number, string>()

  const ordered = [
    ...dimaconEmployees.filter((d) => !d.isArchived),
    ...dimaconEmployees.filter((d) => d.isArchived),
  ]

  for (const d of ordered) {
    const key = personnelNumberKey(d.personnelNumber)
    const candidates = key ? (byPersonnelNumber.get(key) ?? []).filter((c) => !used.has(c.id)) : []

    if (candidates.length === 1) {
      pairs.push({ dimacon: d, clockin: candidates[0] })
      used.add(candidates[0].id)
      continue
    }

    if (candidates.length > 1) {
      ambiguous.push({
        dimacon: d,
        reason: `${candidates.length} Clockin-Mitarbeiter mit Personalnummer ${d.personnelNumber?.trim()}`,
      })
      // Genau diese Kandidaten landen ungefiltert in `clockinOnly` — als
      // Anlage-Kandidat sind sie disqualifiziert, solange die Zuordnung
      // nicht eindeutig ist.
      for (const c of candidates) {
        if (!blockedClockinIds.has(c.id)) {
          blockedClockinIds.set(
            c.id,
            `mehrdeutige Zuordnung zu ${d.firstName} ${d.lastName} über die Personalnummer`,
          )
        }
      }
      continue
    }

    if (!d.isArchived) dimaconOnly.push(d)
  }

  // Dubletten in Clockin: dieselbe Person steht zweimal drin — der zweite
  // Datensatz darf nicht als "fehlt in Dimacon" durchgehen und dort ein
  // Duplikat erzeugen. Zwei Fälle, beide gefährlich: (a) der erste Datensatz
  // wurde bereits einem Dimacon-Mitarbeiter zugeordnet, (b) BEIDE Datensätze
  // sind ungematcht — dann würde die Anlage zwei neue Dimacon-Mitarbeiter für
  // dieselbe Person erzeugen (Issue #17). Deshalb beansprucht der erste
  // ungematchte Datensatz seine Keys, jeder weitere gilt als Dublette.
  const matchedKeys = new Map<string, number>()
  for (const pair of pairs) {
    for (const key of matchKeys(pair.clockin)) matchedKeys.set(key, pair.clockin.id)
  }
  const unmatchedKeys = new Map<string, number>()
  for (const c of clockinEmployees) {
    if (used.has(c.id) || blockedClockinIds.has(c.id)) continue
    const keys = matchKeys(c)
    let duplicateOf: string | undefined
    for (const key of keys) {
      const matchedId = matchedKeys.get(key)
      if (matchedId !== undefined && matchedId !== c.id) {
        duplicateOf = `Dublette in Clockin zu bereits zugeordnetem Datensatz #${matchedId}`
        break
      }
      const twinId = unmatchedKeys.get(key)
      if (twinId !== undefined && twinId !== c.id) {
        duplicateOf = `Dublette in Clockin zu Datensatz #${twinId}`
        break
      }
    }
    if (duplicateOf !== undefined) {
      blockedClockinIds.set(c.id, duplicateOf)
      continue
    }
    for (const key of keys) unmatchedKeys.set(key, c.id)
  }

  return {
    pairs,
    dimaconOnly,
    clockinOnly: clockinEmployees.filter((c) => !used.has(c.id)),
    ambiguous,
    blockedClockinIds,
  }
}

/**
 * Identitäts-Schlüssel eines Clockin-Datensatzes für die Dubletten-Sperre.
 * Bewusst breiter als der Match (nur PNr): hier bremsen sie eine Anlage,
 * verknüpfen aber nichts.
 */
function matchKeys(c: ClockinEmployeeInfo): string[] {
  const keys: string[] = []
  const personnelNumber = norm(c.personnelNumber)
  if (personnelNumber) keys.push(`pn:${personnelNumber}`)
  const email = norm(c.email)
  if (email) keys.push(`mail:${email}`)
  const name = fullName(c.firstName, c.lastName)
  if (name) keys.push(`name:${name}`)
  return keys
}

export interface PairDiff {
  /** Felder, die in Clockin auf den Dimacon-Stand gebracht werden müssen */
  clockinChanges: string[]
}

/**
 * Dimacon gewinnt: Namensabweichungen werden in Clockin korrigiert. Die
 * Personalnummer ist per Konstruktion gleich (einziger Match-Schlüssel);
 * alle weiteren Felder (Telefon etc.) laufen über die Feld-Zuordnung.
 */
export function diffPair(d: DimaconEmployeeFull, c: ClockinEmployeeInfo): PairDiff {
  const changes: string[] = []

  if (d.firstName.trim() !== (c.firstName ?? "").trim()) changes.push("firstName")
  if (d.lastName.trim() !== (c.lastName ?? "").trim()) changes.push("lastName")

  return { clockinChanges: changes }
}

/** Normalisierter Match-Schlüssel einer Personalnummer ("" = keine) */
export function personnelNumberKey(s: string | undefined): string {
  return norm(s)
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
