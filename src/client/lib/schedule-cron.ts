/**
 * Übersetzung zwischen der Picker-UI des Zeitplan-Editors und Cron-Ausdrücken.
 * Rein client-seitig — Server/DB kennen weiterhin nur den Cron-String.
 *
 * Bewusst eng: nur Muster, die die Picker exakt abbilden können, werden
 * zurück-geparst; alles andere landet im Experten-Modus. Intervalle sind auf
 * saubere Teiler von 60/24 beschränkt, weil Cron krumme Rhythmen nicht echt
 * kann — ein 45-Minuten-Step feuert zu :00 und :45, nicht alle 45 Minuten.
 */

export type ScheduleSpec =
  | { mode: "daily"; hour: number; minute: number; days: number[] } // Cron-Tage 0–6, So=0
  | { mode: "interval"; unit: "minutes" | "hours"; every: number }
  | { mode: "expert"; cron: string }

export const INTERVAL_MINUTES = [5, 10, 15, 20, 30] as const
export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const

export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0] // Mo–So in Anzeige-Reihenfolge
export const WEEKDAYS = [1, 2, 3, 4, 5]

export const DAY_LABELS: Record<number, string> = {
  1: "Mo",
  2: "Di",
  3: "Mi",
  4: "Do",
  5: "Fr",
  6: "Sa",
  0: "So",
}

export const DEFAULT_SPEC: ScheduleSpec = { mode: "daily", hour: 6, minute: 0, days: ALL_DAYS }

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",")
}

function daysToCron(days: number[]): string {
  if (days.length === 7) return "*"
  if (sameDays(days, WEEKDAYS)) return "1-5"
  return [...days].sort((x, y) => x - y).join(",")
}

export function specToCron(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case "daily":
      return `${spec.minute} ${spec.hour} * * ${daysToCron(spec.days)}`
    case "interval":
      if (spec.unit === "minutes") return `*/${spec.every} * * * *`
      return spec.every === 1 ? "0 * * * *" : `0 */${spec.every} * * *`
    case "expert":
      return spec.cron
  }
}

function parseDays(expr: string): number[] | undefined {
  if (expr === "*") return ALL_DAYS
  const days = new Set<number>()
  for (const part of expr.split(",")) {
    const range = part.match(/^([0-6])-([0-6])$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      // Wrap-around-Ranges (z. B. 5-1) bilden die Picker nicht ab → Experte.
      if (from > to) return undefined
      for (let d = from; d <= to; d++) days.add(d)
      continue
    }
    if (!/^[0-6]$/.test(part)) return undefined
    days.add(Number(part))
  }
  return days.size > 0 ? [...days] : undefined
}

/** Parst nur Picker-abbildbare Muster; sonst (oder leer) Experte/Default. */
export function cronToSpec(cron: string | undefined): ScheduleSpec {
  if (!cron || cron.trim().length === 0) return DEFAULT_SPEC
  const trimmed = cron.trim()

  const daily = trimmed.match(/^(\d{1,2}) (\d{1,2}) \* \* (\S+)$/)
  if (daily) {
    const minute = Number(daily[1])
    const hour = Number(daily[2])
    const days = parseDays(daily[3])
    if (minute <= 59 && hour <= 23 && days) {
      return { mode: "daily", hour, minute, days }
    }
    return { mode: "expert", cron: trimmed }
  }

  const everyMinutes = trimmed.match(/^\*\/(\d{1,2}) \* \* \* \*$/)
  if (everyMinutes && (INTERVAL_MINUTES as readonly number[]).includes(Number(everyMinutes[1]))) {
    return { mode: "interval", unit: "minutes", every: Number(everyMinutes[1]) }
  }

  if (trimmed === "0 * * * *") {
    return { mode: "interval", unit: "hours", every: 1 }
  }
  const everyHours = trimmed.match(/^0 \*\/(\d{1,2}) \* \* \*$/)
  if (everyHours && (INTERVAL_HOURS as readonly number[]).includes(Number(everyHours[1]))) {
    return { mode: "interval", unit: "hours", every: Number(everyHours[1]) }
  }

  return { mode: "expert", cron: trimmed }
}

function two(n: number): string {
  return String(n).padStart(2, "0")
}

function describeDays(days: number[]): string {
  if (days.length === 7) return ""
  if (sameDays(days, WEEKDAYS)) return " (Mo–Fr)"
  const ordered = ALL_DAYS.filter((d) => days.includes(d))
  return ` (${ordered.map((d) => DAY_LABELS[d]).join(", ")})`
}

/** Deutsche Zusammenfassung für die Anzeige unter den Pickern. */
export function describeSpec(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case "daily":
      return `Täglich um ${two(spec.hour)}:${two(spec.minute)}${describeDays(spec.days)}`
    case "interval":
      if (spec.unit === "minutes") return `Alle ${spec.every} Minuten`
      return spec.every === 1 ? "Stündlich" : `Alle ${spec.every} Stunden`
    case "expert":
      return "Eigener Cron-Ausdruck"
  }
}
