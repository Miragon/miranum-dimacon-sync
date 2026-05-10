const DEFAULT_START_HHMM = "07:30"

export function startDateForClockin(date: string, hhmm: string = DEFAULT_START_HHMM): string {
  const [hours, minutes] = hhmm.split(":").map(Number)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new Error(`invalid time of day: ${hhmm}`)
  }
  const offset = berlinOffsetForDate(date, hours, minutes)
  return `${date}T${pad(hours)}:${pad(minutes)}:00${offset}`
}

export function berlinOffsetForDate(date: string, hours = 12, minutes = 0): "+01:00" | "+02:00" {
  const [y, m, d] = date.split("-").map(Number)
  const utcMs = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hours, minutes)
  const berlinDate = new Date(utcMs).toLocaleString("en-US", {
    timeZone: "Europe/Berlin",
    timeZoneName: "shortOffset",
  })
  return berlinDate.includes("GMT+2") ? "+02:00" : "+01:00"
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

export function splitZipCity(zipCity: string | undefined): { zip: string; city: string } {
  if (!zipCity) return { zip: "", city: "" }
  const trimmed = zipCity.trim()
  const m = trimmed.match(/^(\d{4,5})\s+(.+)$/)
  if (m) return { zip: m[1], city: m[2] }
  return { zip: "", city: trimmed }
}
