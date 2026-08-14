/* eslint-disable no-console -- CLI-Diagnose-Skript, Ausgabe ist der Zweck */
/**
 * Prüft empirisch, ob Clockin-Projekt-Updates Replace- oder Merge-Semantik
 * haben: liest ein Projekt, schickt ein minimales Update (nur name +
 * archived) und vergleicht, welche Felder danach noch da sind.
 *
 *   pnpm tsx scripts/probe-clockin-update-semantics.ts <projectId>
 */
import "dotenv/config"
import { sdk as clockin } from "@miragon/client-clockin"
import { getClockInClient } from "../src/server/lib/clients.js"

interface Row {
  id?: number
  name?: string
  number?: string | null
  description?: string | null
  start_date?: string | null
  destination_city?: string | null
  archived?: boolean
  customer?: { id?: number }
}

async function getProject(client: ReturnType<typeof getClockInClient>, id: number): Promise<Row> {
  const res = (await clockin.getProject({
    client,
    path: { project: id },
    query: { include: "customer" },
  })) as unknown as { data?: Row }
  return res.data ?? {}
}

async function main() {
  const id = Number(process.argv[2])
  if (!Number.isFinite(id)) throw new Error("usage: probe-clockin-update-semantics.ts <projectId>")
  const client = getClockInClient()

  const before = await getProject(client, id)
  console.log("vorher:", JSON.stringify(before, null, 2).slice(0, 600))

  await clockin.updateProject({
    client,
    path: { project: id },
    body: { name: before.name ?? "probe", archived: before.archived ?? false },
  })

  const after = await getProject(client, id)
  console.log("nachher:", JSON.stringify(after, null, 2).slice(0, 600))

  const kept = (field: keyof Row) =>
    `${field}: ${JSON.stringify(before[field])} → ${JSON.stringify(after[field])}`
  console.log("\n# Verdikt (Minimal-Body nur {name, archived}):")
  for (const f of ["number", "description", "start_date", "destination_city"] as const) {
    console.log(" ", kept(f))
  }
  console.log("  customer:", before.customer?.id, "→", after.customer?.id)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
