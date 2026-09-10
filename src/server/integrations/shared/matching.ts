/**
 * Gemeinsame Normalisierung und Duplikat-Erkennung für das Kunden-Matching.
 *
 * Bewusst pur (kein API-Zugriff, keine Abhängigkeiten): Duplikat-Erkennung
 * und Match-Vergleich MÜSSEN dieselbe Normalisierung verwenden — sonst gilt
 * ein Name im Vorab-Check als eindeutig, im Vergleich aber als Treffer
 * (oder umgekehrt) und die Mehrdeutigkeit wäre wieder unsichtbar.
 */

/** trim + lowercase + Kollaps von Mehrfach-Whitespace; undefined/null → "". */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Liefert alle normalisierten Schlüssel, die in der Liste MEHR ALS EINMAL
 * vorkommen. Leere/fehlende Schlüssel zählen nie als Duplikat (Kunden ohne
 * Kundennummer sind nicht "alle gleich").
 */
export function duplicateKeys<T>(
  items: readonly T[],
  key: (item: T) => string | null | undefined,
): ReadonlySet<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const item of items) {
    const k = normalizeName(key(item))
    if (!k) continue
    if (seen.has(k)) duplicates.add(k)
    else seen.add(k)
  }
  return duplicates
}
