import { createContext, useCallback, useContext } from "react"

type TokenGetter = () => Promise<string>

export const TokenContext = createContext<TokenGetter | null>(null)

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>

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
