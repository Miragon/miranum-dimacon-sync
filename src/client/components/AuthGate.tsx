import { useAuth } from "@workos-inc/authkit-react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { TenantGate } from "#/components/TenantGate"
import { Button } from "#/components/ui/button"
import { TokenContext } from "#/lib/api"

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, signIn, getAccessToken } = useAuth()
  const [signInError, setSignInError] = useState<string | null>(null)

  const startSignIn = useCallback(() => {
    setSignInError(null)
    signIn().catch((err: unknown) => {
      setSignInError(err instanceof Error ? err.message : String(err))
    })
  }, [signIn])

  useEffect(() => {
    if (!isLoading && !user && !signInError) {
      startSignIn()
    }
  }, [isLoading, user, signInError, startSignIn])

  const auth = useMemo(
    () => (user ? { getToken: getAccessToken, forceReauth: startSignIn } : null),
    [user, getAccessToken, startSignIn],
  )

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        {signInError ? (
          <div className="w-full max-w-md space-y-4 px-6">
            <MnAlert label="Anmeldung fehlgeschlagen">{signInError}</MnAlert>
            <Button onClick={startSignIn}>erneut versuchen</Button>
          </div>
        ) : (
          <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
            weiterleiten zu workos …
          </p>
        )}
      </div>
    )
  }

  return (
    <TokenContext.Provider value={auth}>
      <TenantGate>{children}</TenantGate>
    </TokenContext.Provider>
  )
}
