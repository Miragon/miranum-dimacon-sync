import { useAuth } from "@workos-inc/authkit-react"
import { useEffect, useMemo, type ReactNode } from "react"
import { TokenContext } from "#/lib/api"

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, signIn, getAccessToken } = useAuth()

  const tokenGetter = useMemo(() => (user ? getAccessToken : null), [user, getAccessToken])

  useEffect(() => {
    if (!isLoading && !user) {
      void signIn()
    }
  }, [isLoading, user, signIn])

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
          weiterleiten zu workos …
        </p>
      </div>
    )
  }

  return <TokenContext.Provider value={tokenGetter}>{children}</TokenContext.Provider>
}
