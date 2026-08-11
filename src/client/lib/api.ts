import { createContext, useCallback, useContext } from "react"

type TokenGetter = () => Promise<string>

export const TokenContext = createContext<TokenGetter | null>(null)

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
  const getToken = useContext(TokenContext)
  return useCallback<ApiFetch>(
    async (input, init) => {
      const headers = new Headers(init?.headers)
      if (getToken) {
        const token = await getToken()
        headers.set("Authorization", `Bearer ${token}`)
      }
      return fetch(input, { ...init, headers })
    },
    [getToken],
  )
}
