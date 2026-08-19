import { useAuth } from "@workos-inc/authkit-react"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { Button } from "#/components/ui/button"
import { readJson, useApiFetch } from "#/lib/api"
import { TenantContext, type TenantContextValue } from "#/lib/tenant"

interface MeResponse {
  userId: string
  organizationId: string | null
  tenant: { id: string; name: string }
}

interface MeError {
  error: string
  code?: "NO_ORG" | "UNKNOWN_ORG" | "ORG_INACTIVE"
  organizationId?: string | null
}

type GateState =
  | { kind: "loading" }
  | { kind: "ready"; value: TenantContextValue }
  | { kind: "denied"; code: MeError["code"]; organizationId: string | null }
  | { kind: "error"; message: string }

/**
 * Mandanten-Gate unterhalb des AuthGate: lädt /api/me (+ /api/tenants) und
 * stellt den aktiven Mandanten bereit. Unbekannte/inaktive Organisationen
 * bekommen einen freundlichen Vollbild-Zustand statt terminaler 403-Fehler
 * auf jedem Screen.
 */
export function TenantGate({ children }: { children: ReactNode }) {
  const { signOut } = useAuth()
  const apiFetch = useApiFetch()
  const [state, setState] = useState<GateState>({ kind: "loading" })

  const load = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const meRes = await apiFetch("/api/me")
      const me = await readJson<MeResponse | MeError>(meRes)
      if (!meRes.ok) {
        const err = me as MeError
        if (meRes.status === 403 && err.code) {
          setState({ kind: "denied", code: err.code, organizationId: err.organizationId ?? null })
        } else {
          setState({ kind: "error", message: err.error ?? `HTTP ${meRes.status}` })
        }
        return
      }
      const ok = me as MeResponse

      let tenants: TenantContextValue["tenants"] = []
      try {
        const listRes = await apiFetch("/api/tenants")
        if (listRes.ok) {
          tenants = await readJson<TenantContextValue["tenants"]>(listRes)
        }
      } catch {
        // Switcher-Liste ist optional — ohne sie bleibt der aktive Mandant nutzbar.
      }

      setState({
        kind: "ready",
        value: { tenant: ok.tenant, tenants, organizationId: ok.organizationId },
      })
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [apiFetch])

  useEffect(() => {
    void load()
  }, [load])

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
          mandant wird geladen …
        </p>
      </div>
    )
  }

  if (state.kind === "denied") {
    const noOrg = state.code === "NO_ORG"
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md space-y-4 px-6">
          <MnAlert label={noOrg ? "Keine Organisation" : "Kein Zugang"}>
            {noOrg ? (
              <>
                Ihre Anmeldung ist keiner Organisation zugeordnet. Bitte melden Sie sich neu an und
                wählen Sie dabei Ihre Organisation aus.
              </>
            ) : state.code === "ORG_INACTIVE" ? (
              <>Ihre Organisation ist derzeit deaktiviert. Bitte wenden Sie sich an den Support.</>
            ) : (
              <>Ihre Organisation ist für dieses Sync-Tool nicht freigeschaltet.</>
            )}
            {state.organizationId ? (
              <span className="text-ink-3 mt-3 block font-mono text-[0.7rem]">
                {state.organizationId}
              </span>
            ) : null}
          </MnAlert>
          <div className="flex gap-3">
            <Button onClick={() => signOut()}>Abmelden</Button>
            <Button variant="outline" onClick={() => signOut({ returnTo: window.location.origin })}>
              Mit anderem Konto anmelden
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (state.kind === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md space-y-4 px-6">
          <MnAlert label="Fehler">{state.message}</MnAlert>
          <Button onClick={() => void load()}>erneut versuchen</Button>
        </div>
      </div>
    )
  }

  return <TenantContext.Provider value={state.value}>{children}</TenantContext.Provider>
}
