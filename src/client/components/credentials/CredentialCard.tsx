import { useEffect, useRef, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { readJson, useApiFetch } from "#/lib/api"
import type { CredentialStatus, SystemDef } from "#/lib/credentials"

export function CredentialCard({
  system,
  status,
  onSaved,
}: {
  system: SystemDef
  status: CredentialStatus
  onSaved: (updated: CredentialStatus) => void
}) {
  const apiFetch = useApiFetch()
  const [token, setToken] = useState("")
  const [config, setConfig] = useState<Record<string, string>>(() => ({ ...status.config }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setConfig({ ...status.config })
    setToken("")
  }, [status])

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    },
    [],
  )

  const dirty =
    token.length > 0 ||
    system.fields.some((f) => (config[f.key] ?? "") !== (status.config[f.key] ?? ""))

  const updatedAtLabel = status.updatedAt
    ? new Date(status.updatedAt).toLocaleString("de-DE", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    setProbeResult(null)
    try {
      const body: Record<string, string> = { ...config }
      if (token.length > 0) body.token = token
      const res = await apiFetch(`/api/credentials/${system.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await readJson<CredentialStatus | { error: string }>(res)
      if (!res.ok) {
        const err = json as { error: string }
        setError(
          err.error === "token_required"
            ? `${system.tokenLabel} wird beim ersten Speichern benötigt.`
            : err.error,
        )
      } else {
        setToken("")
        setNotice("Gespeichert. Tokens werden verschlüsselt abgelegt und nie wieder angezeigt.")
        onSaved(json as CredentialStatus)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function probe() {
    setProbing(true)
    setProbeResult(null)
    try {
      const res = await apiFetch(system.probePath)
      if (res.ok) {
        setProbeResult({ ok: true, message: `Verbindung OK (HTTP ${res.status})` })
      } else {
        const json = await readJson<{ error?: string }>(res).catch(() => ({ error: undefined }))
        setProbeResult({ ok: false, message: json.error ?? `HTTP ${res.status}` })
      }
    } catch (err) {
      setProbeResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setProbing(false)
    }
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 4000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmDelete(false)
    setSaving(true)
    setError(null)
    setNotice(null)
    setProbeResult(null)
    try {
      const res = await apiFetch(`/api/credentials/${system.id}`, { method: "DELETE" })
      if (res.status !== 204) {
        const json = await readJson<{ error?: string }>(res).catch(() => ({ error: undefined }))
        setError(json.error ?? `HTTP ${res.status}`)
      } else {
        setToken("")
        setConfig({})
        setNotice("Zugangsdaten gelöscht.")
        onSaved({ ...status, configured: false, updatedAt: null, keyVersion: null, config: {} })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const fieldId = (suffix: string) => `cred-${system.id}-${suffix}`

  return (
    <section>
      <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
        {system.name}
      </h2>

      <dl className="border-rule mb-6 grid grid-cols-3 border">
        <Stat label="Status">
          {status.configured ? (
            <MnStatusBadge variant="ok">hinterlegt</MnStatusBadge>
          ) : (
            <MnStatusBadge variant="warn">nicht hinterlegt</MnStatusBadge>
          )}
        </Stat>
        <Stat label="Hinterlegt am">
          <span className="text-ink text-base">{updatedAtLabel ?? "—"}</span>
        </Stat>
        <Stat label="Schlüssel-Version">
          <span className="text-ink font-mono text-base">
            {status.keyVersion ? `v${status.keyVersion}` : "—"}
          </span>
        </Stat>
      </dl>

      <div className="border-rule space-y-6 border p-6">
        <div>
          <Label htmlFor={fieldId("token")}>{system.tokenLabel}</Label>
          <Input
            id={fieldId("token")}
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              status.configured
                ? `•••••••• — hinterlegt${updatedAtLabel ? ` am ${updatedAtLabel}` : ""}`
                : `${system.tokenLabel} einfügen`
            }
            className="mt-2 font-mono"
            disabled={saving}
          />
          {status.configured ? (
            <p className="text-ink-3 mt-2 font-mono text-[0.7rem]">
              Leer lassen, um das bestehende Token zu behalten.
            </p>
          ) : null}
        </div>

        {system.fields.map((f) => (
          <div key={f.key} className="max-w-[420px]">
            <Label htmlFor={fieldId(f.key)}>{f.label}</Label>
            <Input
              id={fieldId(f.key)}
              type="text"
              value={config[f.key] ?? ""}
              onChange={(e) => setConfig((prev) => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className="mt-2 font-mono"
              disabled={saving}
            />
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "speichere …" : "Speichern"}
          </Button>
          <Button
            variant="outline"
            onClick={() => void probe()}
            disabled={probing || saving || !status.configured}
          >
            {probing ? "teste …" : "Verbindung testen"}
          </Button>
          {status.configured ? (
            <Button variant="ghost" onClick={() => void remove()} disabled={saving}>
              {confirmDelete ? "Wirklich löschen?" : "Löschen"}
            </Button>
          ) : null}
          {dirty ? (
            <span className="text-ink-3 font-mono text-[0.7rem] tracking-[0.18em] uppercase">
              ungespeicherte änderungen
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <MnAlert label="Fehler" className="mt-6">
          {error}
        </MnAlert>
      ) : null}
      {notice && !error ? <OkNotice>{notice}</OkNotice> : null}
      {probeResult ? (
        probeResult.ok ? (
          <OkNotice>{probeResult.message}</OkNotice>
        ) : (
          <MnAlert label="Verbindung fehlgeschlagen" className="mt-6">
            {probeResult.message}
          </MnAlert>
        )
      ) : null}
    </section>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-rule border-r p-4 last:border-r-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className="mt-2">{children}</dd>
    </div>
  )
}

function OkNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-rule text-ink-2 border-l-ink mt-6 border border-l-[3px] px-4 py-3 text-sm">
      <strong className="text-ink mb-1.5 block font-mono text-[0.7rem] font-semibold tracking-[0.18em] uppercase">
        OK
      </strong>
      {children}
    </div>
  )
}
