import { useCallback, useEffect, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MappingEditor } from "#/components/mapping/MappingEditor"
import type { MappingEntityBlock } from "#/components/mapping/MappingEditor"
import { readJson, useApiFetch } from "#/lib/api"

// Aus der früheren Route /sync/<id>/mapping extrahiert — lebt jetzt als
// Tab „Feld-Zuordnung" auf der Einstellungsseite der Integration.

const ENTITY_LABELS: Record<MappingEntityBlock["entity"], string> = {
  project: "Projekt",
  customer: "Kunde",
  employee: "Mitarbeiter",
  lexofficeContact: "Lexware-Kontakt",
  dimaconCustomer: "Dimacon-Kunde (aus Lexware)",
}

interface MappingsResponse {
  integrationId: string
  entities: MappingEntityBlock[]
}

export function MappingPanel({ integrationId }: { integrationId: string }) {
  const apiFetch = useApiFetch()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<MappingEntityBlock[]>([])
  const [activeEntity, setActiveEntity] = useState<MappingEntityBlock["entity"] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await apiFetch(`/api/mappings/${integrationId}`)
      if (res.status === 404) {
        setLoadError("Für diese Integration gibt es keine Feld-Zuordnung.")
        return
      }
      const json = await readJson<MappingsResponse | { error: string }>(res)
      if (!res.ok || "error" in json) {
        setLoadError("error" in json ? json.error : `HTTP ${res.status}`)
        return
      }
      setBlocks(json.entities)
      // Bei Param-Navigation zwischen Integrationen kann ein alter Tab-Wert
      // überleben, den es hier nicht gibt — dann auf die erste Entität zurück.
      setActiveEntity((current) =>
        current && json.entities.some((b) => b.entity === current)
          ? current
          : (json.entities[0]?.entity ?? null),
      )
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch, integrationId])

  useEffect(() => {
    void load()
  }, [load])

  const active = blocks.find((b) => b.entity === activeEntity) ?? null

  return (
    <div>
      <p className="text-body-sm text-ink-2 mb-8 max-w-[540px]">
        Legt fest, welche Quellfelder in welche Zielfelder geschrieben werden — inklusive
        Custom-Attributen und Custom-Feldern, wo die Systeme sie kennen. Fixierte Zeilen sind
        Match-Keys und nicht veränderbar. Entfernte Regeln löschen bereits geschriebene Werte nicht
        — das Feld wird nur nicht mehr gepflegt.
      </p>

      {loading ? <p className="text-ink-3 font-mono text-sm">lade …</p> : null}
      {loadError ? <MnAlert label="Fehler">{loadError}</MnAlert> : null}

      {!loading && !loadError && blocks.length > 0 ? (
        <>
          {blocks.length > 1 ? (
            <div className="mb-8 flex flex-wrap gap-3">
              {blocks.map((b) => (
                <button
                  key={b.entity}
                  type="button"
                  onClick={() => setActiveEntity(b.entity)}
                  className={`border px-3 py-1.5 font-mono text-[0.7rem] tracking-[0.14em] uppercase transition-colors ${
                    b.entity === activeEntity
                      ? "border-ink text-ink"
                      : "border-rule text-ink-2 hover:border-ink hover:text-ink"
                  }`}
                >
                  {ENTITY_LABELS[b.entity]}
                </button>
              ))}
            </div>
          ) : null}

          {active ? (
            <MappingEditor
              key={active.entity}
              integrationId={integrationId}
              block={active}
              onSaved={(saved) =>
                setBlocks((prev) => prev.map((b) => (b.entity === saved.entity ? saved : b)))
              }
            />
          ) : null}

          {active?.entity === "customer" ? (
            <p className="text-ink-3 mt-6 max-w-[540px] font-mono text-[0.65rem] leading-relaxed">
              Die Kunden-Zuordnung wirkt beim Anlegen neuer Clockin-Kunden — bestehende Kunden
              werden vom Sync nicht aktualisiert.
            </p>
          ) : null}
          {active?.entity === "dimaconCustomer" ? (
            <p className="text-body-sm text-ink-2 mt-6 max-w-[540px]">
              Die Zuordnung wirkt nur, wenn die Übernahme neue Dimacon-Kunden anlegt (Schritt
              „Kunden aus Lexware in Dimacon anlegen“ im Umfang) — bestehende Kunden werden nicht
              aktualisiert. Name und Kundennummer sind fixiert. Mit * markierte Attribute verlangt
              Dimacon: Solange eines davon keine Quelle hat, legt die Übernahme keinen Kunden an.
              Auswahlfelder kann die Übernahme noch nicht befüllen.
            </p>
          ) : null}
          {active?.entity === "lexofficeContact" ? (
            <p className="text-ink-3 mt-6 max-w-[540px] font-mono text-[0.65rem] leading-relaxed">
              Die Zuordnung wirkt beim Anlegen neuer Lexware-Kontakte — bestehende Kontakte werden
              vom Sync nicht aktualisiert.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
