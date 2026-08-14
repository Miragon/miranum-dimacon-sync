import { useMemo, useState } from "react"
import type { DragEvent } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Button } from "#/components/ui/button"
import { readJson, useApiFetch } from "#/lib/api"

// ── Typen (Spiegel der Server-Antwort von /api/mappings/:id) ───────────────

export type SourceRef =
  | { kind: "standard"; field: string }
  | { kind: "attribute"; attributeId: string }

export type TargetRef =
  | { kind: "standard"; field: string }
  | { kind: "custom"; customFieldId: number }

export interface MappingRule {
  source: SourceRef
  target: TargetRef
}

export interface MappingEntityBlock {
  entity: "project" | "customer" | "employee" | "lexofficeContact"
  isDefault: boolean
  rules: MappingRule[]
  locked: { sourceLabel: string; targetField: string; note: string }[]
  requiredTargets: string[]
  writeSemantics: "overwrite" | "fillIfNonEmpty"
  sources: {
    standard: { field: string; label: string }[]
    attributes: { id: string; label: string; type: string; isActive: boolean }[]
  }
  targets: {
    standard: { field: string; label: string; dataType: string }[]
    custom: { id: number; label: string; dataType: string }[]
  }
  warnings: string[]
  discoveryErrors: string[]
}

// ── Hilfen ──────────────────────────────────────────────────────────────────

function targetKey(t: TargetRef): string {
  return t.kind === "standard" ? `standard:${t.field}` : `custom:${t.customFieldId}`
}

function sourceLabel(block: MappingEntityBlock, source: SourceRef): string {
  if (source.kind === "standard") {
    return block.sources.standard.find((s) => s.field === source.field)?.label ?? source.field
  }
  const attr = block.sources.attributes.find((a) => a.id === source.attributeId)
  return attr ? attr.label : `Attribut ${source.attributeId}`
}

function rulesEqual(a: MappingRule[], b: MappingRule[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Zielsystem je Entität — Lexware-Kontakte haben Lexware-, alle anderen Clockin-Ziele. */
function targetSystem(entity: MappingEntityBlock["entity"]): string {
  return entity === "lexofficeContact" ? "Lexware-Office" : "Clockin"
}

// ── Editor ──────────────────────────────────────────────────────────────────

export function MappingEditor({
  integrationId,
  block,
  onSaved,
}: {
  integrationId: string
  block: MappingEntityBlock
  onSaved: (block: MappingEntityBlock) => void
}) {
  const apiFetch = useApiFetch()
  const [rules, setRules] = useState<MappingRule[]>(block.rules)
  const [dragging, setDragging] = useState<SourceRef | null>(null)
  const [hoverTarget, setHoverTarget] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dirty = useMemo(() => !rulesEqual(rules, block.rules), [rules, block.rules])
  const ruleByTarget = useMemo(() => new Map(rules.map((r) => [targetKey(r.target), r])), [rules])

  // Regeln, deren Ziel nicht (mehr) existiert (z. B. gelöschtes Custom-Field):
  // sichtbar machen und entfernbar halten, sonst blockieren sie das Speichern.
  const orphanRules = useMemo(() => {
    const known = new Set([
      ...block.targets.standard.map((t) => `standard:${t.field}`),
      ...block.targets.custom.map((t) => `custom:${t.id}`),
    ])
    return rules.filter((r) => !known.has(targetKey(r.target)))
  }, [rules, block.targets])

  function dropOn(target: TargetRef, e: DragEvent) {
    e.preventDefault()
    setHoverTarget(null)
    const payload = e.dataTransfer.getData("text/plain")
    if (!payload) return
    let source: SourceRef
    try {
      source = JSON.parse(payload) as SourceRef
    } catch {
      return
    }
    const key = targetKey(target)
    setRules((prev) => [...prev.filter((r) => targetKey(r.target) !== key), { source, target }])
    setNotice(null)
  }

  function removeRule(target: TargetRef) {
    const key = targetKey(target)
    setRules((prev) => prev.filter((r) => targetKey(r.target) !== key))
    setNotice(null)
  }

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const res = await apiFetch(`/api/mappings/${integrationId}/${block.entity}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      })
      const json = await readJson<MappingEntityBlock | { error: string; details?: unknown }>(res)
      if (!res.ok || "error" in json) {
        // details ist string[] aus validateRules oder ein Zod-flatten()-Objekt
        const raw = "details" in json ? json.details : undefined
        const details = Array.isArray(raw)
          ? ` — ${raw.join("; ")}`
          : raw
            ? ` — ${JSON.stringify(raw)}`
            : ""
        setError(("error" in json ? json.error : `HTTP ${res.status}`) + details)
        return
      }
      setRules(json.rules)
      onSaved(json)
      setNotice("Gespeichert.")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    if (!window.confirm("Zuordnung auf den Standard zurücksetzen?")) return
    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/mappings/${integrationId}/${block.entity}`, {
        method: "DELETE",
      })
      const json = await readJson<MappingEntityBlock | { error: string }>(res)
      if (!res.ok || "error" in json) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
        return
      }
      setRules(json.rules)
      onSaved(json)
      setNotice("Auf Standard zurückgesetzt.")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {block.discoveryErrors.length > 0 ? (
        <MnAlert label="Discovery" className="mb-6">
          Custom-Attribute/-Felder konnten nicht geladen werden: {block.discoveryErrors.join("; ")}
        </MnAlert>
      ) : null}
      {block.warnings.length > 0 ? (
        <MnAlert label="Veraltete Regeln" className="mb-6">
          {block.warnings.join("; ")}
        </MnAlert>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Quellen */}
        <div>
          <h3 className="text-ink mb-3 font-mono text-[0.7rem] tracking-[0.18em] uppercase">
            Dimacon-Quellfelder
          </h3>
          <div className="border-rule divide-rule divide-y border">
            {block.sources.standard.map((s) => (
              <SourceCard
                key={`std:${s.field}`}
                label={s.label}
                badge={null}
                source={{ kind: "standard", field: s.field }}
                dragging={dragging}
                setDragging={setDragging}
              />
            ))}
            {block.sources.attributes.map((a) => (
              <SourceCard
                key={`attr:${a.id}`}
                label={a.label}
                badge={a.type}
                inactive={!a.isActive}
                source={{ kind: "attribute", attributeId: a.id }}
                dragging={dragging}
                setDragging={setDragging}
              />
            ))}
          </div>
          <p className="text-ink-3 mt-3 font-mono text-[0.65rem] leading-relaxed">
            Feld auf ein {targetSystem(block.entity)}-Ziel ziehen. Eine Quelle darf mehrere Ziele
            füllen.
          </p>
        </div>

        {/* Ziele */}
        <div>
          <h3 className="text-ink mb-3 font-mono text-[0.7rem] tracking-[0.18em] uppercase">
            {targetSystem(block.entity)}-Zielfelder
          </h3>
          <div className="border-rule divide-rule divide-y border">
            {block.locked.map((l) => (
              <div key={l.targetField} className="bg-paper-2 flex items-center gap-3 px-3 py-2">
                <span className="text-ink-3 min-w-0 flex-1 truncate font-mono text-[0.75rem]">
                  {l.sourceLabel} → {l.targetField}
                </span>
                <span className="text-ink-3 font-mono text-[0.6rem] tracking-[0.12em] uppercase">
                  fixiert · {l.note}
                </span>
              </div>
            ))}
            {block.targets.standard.map((t) => (
              <TargetRow
                key={`std:${t.field}`}
                label={t.label}
                badge={null}
                required={block.requiredTargets.includes(t.field)}
                target={{ kind: "standard", field: t.field }}
                rule={ruleByTarget.get(`standard:${t.field}`)}
                block={block}
                dragging={dragging}
                hoverTarget={hoverTarget}
                setHoverTarget={setHoverTarget}
                onDrop={dropOn}
                onRemove={removeRule}
              />
            ))}
            {block.targets.custom.map((t) => (
              <TargetRow
                key={`custom:${t.id}`}
                label={t.label}
                badge={`custom · ${t.dataType}`}
                required={false}
                target={{ kind: "custom", customFieldId: t.id }}
                rule={ruleByTarget.get(`custom:${t.id}`)}
                block={block}
                dragging={dragging}
                hoverTarget={hoverTarget}
                setHoverTarget={setHoverTarget}
                onDrop={dropOn}
                onRemove={removeRule}
              />
            ))}
            {orphanRules.map((r) => (
              <div
                key={targetKey(r.target)}
                className="border-l-mn-accent flex items-center gap-3 border-l-[3px] px-3 py-2"
              >
                <span className="text-ink min-w-0 flex-1 truncate font-mono text-[0.75rem]">
                  {sourceLabel(block, r.source)} →{" "}
                  {r.target.kind === "custom"
                    ? `Custom-Field ${r.target.customFieldId}`
                    : r.target.field}
                </span>
                <span className="text-ink-3 font-mono text-[0.6rem] tracking-[0.12em] uppercase">
                  ziel existiert nicht mehr
                </span>
                <button
                  type="button"
                  onClick={() => removeRule(r.target)}
                  className="text-ink-3 hover:text-ink font-mono text-[0.75rem]"
                  aria-label="Verwaiste Regel entfernen"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "speichert …" : "Speichern"}
        </Button>
        <Button variant="outline" onClick={() => void reset()} disabled={saving}>
          Auf Standard zurücksetzen
        </Button>
        {dirty ? (
          <span className="text-ink-3 font-mono text-[0.7rem] tracking-[0.12em] uppercase">
            ungespeicherte änderungen
          </span>
        ) : null}
        {block.isDefault && !dirty ? <MnStatusBadge>standard-zuordnung</MnStatusBadge> : null}
        {notice ? <span className="text-ink-2 font-mono text-[0.7rem]">{notice}</span> : null}
      </div>
      {error ? (
        <MnAlert label="Fehler" className="mt-4">
          {error}
        </MnAlert>
      ) : null}
    </div>
  )
}

function SourceCard({
  label,
  badge,
  inactive,
  source,
  dragging,
  setDragging,
}: {
  label: string
  badge: string | null
  inactive?: boolean
  source: SourceRef
  dragging: SourceRef | null
  setDragging: (s: SourceRef | null) => void
}) {
  const isDragging = dragging !== null && JSON.stringify(dragging) === JSON.stringify(source)
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify(source))
        e.dataTransfer.effectAllowed = "copy"
        setDragging(source)
      }}
      onDragEnd={() => setDragging(null)}
      className={`flex cursor-grab items-center gap-3 px-3 py-2 select-none ${
        isDragging ? "bg-paper-3" : "bg-paper"
      } ${inactive ? "opacity-50" : ""}`}
    >
      <span className="text-ink-3 font-mono text-[0.7rem]">⠿</span>
      <span className="text-ink min-w-0 flex-1 truncate font-mono text-[0.75rem]">{label}</span>
      {badge ? (
        <span className="border-rule text-ink-3 border px-1.5 py-0.5 font-mono text-[0.6rem] tracking-[0.12em] uppercase">
          {badge}
        </span>
      ) : null}
    </div>
  )
}

function TargetRow({
  label,
  badge,
  required,
  target,
  rule,
  block,
  dragging,
  hoverTarget,
  setHoverTarget,
  onDrop,
  onRemove,
}: {
  label: string
  badge: string | null
  required: boolean
  target: TargetRef
  rule: MappingRule | undefined
  block: MappingEntityBlock
  dragging: SourceRef | null
  hoverTarget: string | null
  setHoverTarget: (k: string | null) => void
  onDrop: (target: TargetRef, e: DragEvent) => void
  onRemove: (target: TargetRef) => void
}) {
  const key = targetKey(target)
  const hovered = hoverTarget === key
  return (
    <div
      onDragOver={(e) => {
        if (!dragging) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        setHoverTarget(key)
      }}
      onDragLeave={() => {
        if (hovered) setHoverTarget(null)
      }}
      onDrop={(e) => onDrop(target, e)}
      className={`flex items-center gap-3 px-3 py-2 ${
        hovered ? "bg-paper-3 border-ink border" : "bg-paper"
      }`}
    >
      <span className="text-ink min-w-0 font-mono text-[0.75rem]">
        {label}
        {required ? <span className="text-ink-3"> *</span> : null}
      </span>
      {badge ? (
        <span className="border-rule text-ink-3 border px-1.5 py-0.5 font-mono text-[0.6rem] tracking-[0.12em] uppercase">
          {badge}
        </span>
      ) : null}
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {rule ? (
          <>
            <span className="border-ink text-ink max-w-[180px] truncate border px-1.5 py-0.5 font-mono text-[0.65rem]">
              ← {sourceLabel(block, rule.source)}
            </span>
            <button
              type="button"
              onClick={() => onRemove(target)}
              className="text-ink-3 hover:text-ink font-mono text-[0.75rem]"
              aria-label={`Zuordnung für ${label} entfernen`}
            >
              ×
            </button>
          </>
        ) : (
          <span className="text-ink-3 font-mono text-[0.65rem]">
            {dragging ? "hierher ziehen" : "—"}
          </span>
        )}
      </span>
    </div>
  )
}
