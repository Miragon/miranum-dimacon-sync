import { createContext, useCallback, useContext } from "react"

export interface AuthTokenContext {
  getToken: () => Promise<string>
  /** startet den PKCE-Flow neu — für abgelaufene Sessions und 401-Antworten */
  forceReauth: () => void
}

export const TokenContext = createContext<AuthTokenContext | null>(null)

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Liest eine JSON-Antwort. Nötig, weil `res.json()` bei leerem Body mit
 * "Unexpected end of JSON input" abbricht und damit die eigentliche Ursache
 * verdeckt — typischerweise ein nicht laufendes Backend, für das der
 * Vite-Proxy einen leeren 500er liefert.
 */
export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()

  if (text.trim() === "") {
    throw new Error(
      res.ok
        ? `Leere Antwort vom Server (HTTP ${res.status})`
        : `Keine Antwort vom Backend (HTTP ${res.status}) — läuft der Server?`,
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    const snippet = text.slice(0, 120).replace(/\s+/g, " ").trim()
    throw new Error(`Ungültige JSON-Antwort (HTTP ${res.status}): ${snippet}`)
  }
}

export function useApiFetch(): ApiFetch {
  const auth = useContext(TokenContext)
  return useCallback<ApiFetch>(
    async (input, init) => {
      const headers = new Headers(init?.headers)
      if (auth) {
        try {
          const token = await auth.getToken()
          headers.set("Authorization", `Bearer ${token}`)
        } catch {
          // authkit wirft LoginRequiredError, wenn der Refresh scheitert —
          // neu anmelden statt eines toten Fehlerbanners.
          auth.forceReauth()
          throw new Error("Sitzung abgelaufen — Anmeldung wird neu gestartet …")
        }
      }
      const res = await fetch(input, { ...init, headers })
      // 401 trotz Token: Session serverseitig ungültig → PKCE-Flow neu starten.
      // 403 (falsche Organisation) bleibt ein normaler Fehler — Re-Login hilft nicht.
      if (res.status === 401 && auth) {
        auth.forceReauth()
      }
      return res
    },
    [auth],
  )
}
