import { useCallback, useEffect, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"
import { readJson, useApiFetch } from "#/lib/api"
import { formatRunDate, type RunHistoryEntry } from "#/lib/integrations"
import { describeScope } from "#/lib/run-scope"

const TRIGGER_LABELS: Record<RunHistoryEntry["trigger"], string> = {
  manual: "manuell",
  cron: "zeitplan",
  webhook: "webhook",
  mcp: "mcp",
}

/**
 * Run-Historie eines Mandanten (letzte Läufe, neueste zuerst). Zeigt vor
 * allem, MIT WELCHEM UMFANG ein Lauf lief — der ist bei geplanten Läufen
 * sonst nirgends sichtbar. `refreshKey` lädt nach einem manuellen Lauf neu.
 */
export function RunHistory({
  integrationId,
  refreshKey,
}: {
  integrationId: string
  refreshKey?: number
}) {
  const apiFetch = useApiFetch()
  const [entries, setEntries] = useState<RunHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/integrations/${integrationId}/runs?limit=20`)
      const json = await readJson<RunHistoryEntry[] | { error: string }>(res)
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        setEntries(json as RunHistoryEntry[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch, integrationId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  return (
    <section className="mt-16">
      <h2 className="text-ink-3 mb-4 font-mono text-[0.65rem] tracking-[0.18em] uppercase">
        Letzte Läufe
      </h2>
      {error ? (
        <MnAlert label="Fehler" className="mb-6">
          {error}
        </MnAlert>
      ) : null}
      {loading ? (
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">lade …</p>
      ) : entries.length === 0 ? (
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
          noch keine läufe aufgezeichnet
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-48">Zeit</TableHead>
              <TableHead className="w-28">Auslöser</TableHead>
              <TableHead className="w-24">Modus</TableHead>
              <TableHead className="w-56">Umfang</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="w-24">Dauer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-mono text-[0.8rem]">
                  {formatRunDate(entry.startedAt)}
                </TableCell>
                <TableCell className="font-mono text-[0.8rem]">
                  {TRIGGER_LABELS[entry.trigger] ?? entry.trigger}
                </TableCell>
                <TableCell className="font-mono text-[0.8rem]">
                  {entry.dryRun ? "dry-run" : "live"}
                </TableCell>
                <TableCell className="font-mono text-[0.8rem]">
                  {describeScope(integrationId, entry.input)}
                </TableCell>
                <TableCell>
                  {/* Akzent-Rot (warn) bleibt dem Run-Button bzw. der
                      Fehlermeldung des Screens vorbehalten — hier reicht der
                      Kontrast ok (gefüllt) ↔ default (Outline). */}
                  {entry.status === "success" ? (
                    <MnStatusBadge variant="ok">ok</MnStatusBadge>
                  ) : (
                    <MnStatusBadge variant="default">
                      {entry.status === "error" ? "fehler" : entry.status}
                    </MnStatusBadge>
                  )}
                  {entry.error ? (
                    <div className="text-ink-2 mt-1 max-w-[320px] text-[0.75rem]">
                      {entry.error}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-[0.8rem]">
                  {entry.durationMs == null ? "—" : `${Math.round(entry.durationMs / 100) / 10} s`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
