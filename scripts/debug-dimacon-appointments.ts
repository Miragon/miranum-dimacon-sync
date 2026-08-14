/**
 * Diagnose: warum liefert der Perioden-Endpoint keine Termine?
 *
 * Lädt alle Job-Termine ungefiltert (zeigt das echte Datumsformat) und
 * probiert dann mehrere from/to-Varianten gegen den Perioden-Endpoint.
 *
 *   pnpm tsx scripts/debug-dimacon-appointments.ts [YYYY-MM-DD]
 */
/* eslint-disable no-console -- CLI-Diagnose-Skript, Ausgabe ist der Zweck */
import "dotenv/config"
import { sdk as dimacon } from "@miragon/client-dimacon"
import { getDimaconClient } from "../src/server/lib/clients.js"
import { todayInBerlin } from "../src/server/integrations/shared/time.js"

interface Appointment {
  id: string
  jobId: string
  date: string
  teamId: string
  isArchived: boolean
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number)
  const next = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1))
  return next.toISOString().slice(0, 10)
}

async function main() {
  const date = process.argv[2] ?? todayInBerlin()
  const client = getDimaconClient()

  console.log(`# Diagnose Dimacon-Termine für ${date}\n`)

  const all = (await dimacon.getAllJobAppointments({ client })) as unknown as Appointment[]
  const archived = all.filter((a) => a.isArchived)
  console.log(
    `getAllJobAppointments (ungefiltert): ${all.length} gesamt, ${archived.length} archiviert`,
  )

  const samples = [...all]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 5)
    .map((a) => ({ date: a.date, jobId: a.jobId, isArchived: a.isArchived }))
  console.log("neueste Termine (Rohformat der date-Werte):")
  console.table(samples)

  const onDate = all.filter((a) => a.date.startsWith(date))
  console.log(`Termine mit date.startsWith("${date}"): ${onDate.length}\n`)

  const variants: [string, { from: string; to: string }][] = [
    ["from=to=Datum (aktueller Code)", { from: date, to: date }],
    ["to=Folgetag", { from: date, to: nextDay(date) }],
    ["Datetime-Grenzen", { from: `${date}T00:00:00`, to: `${date}T23:59:59` }],
    ["Datetime, to=Folgetag 00:00", { from: `${date}T00:00:00`, to: `${nextDay(date)}T00:00:00` }],
  ]

  for (const [label, query] of variants) {
    try {
      const result = (await dimacon.getAllJobAppointmentsInPeriod({
        client,
        query,
      })) as unknown as Appointment[]
      console.log(`${label}  →  ${Array.isArray(result) ? result.length : typeof result} Treffer`)
    } catch (err) {
      console.log(
        `${label}  →  FEHLER: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
      )
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
