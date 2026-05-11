import { useAuth } from "@workos-inc/authkit-react"
import { useMemo, type ReactNode } from "react"
import { Button } from "#/components/ui/button"
import { TokenContext } from "#/lib/api"

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, signIn, getAccessToken } = useAuth()

  const tokenGetter = useMemo(() => (user ? getAccessToken : null), [user, getAccessToken])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
          authentifiziere …
        </p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center p-12">
        <div className="border-rule max-w-[420px] border p-10">
          <span className="mn-mono">/auth · workos</span>
          <h1 className="text-h-2 text-ink mt-4">Sign in</h1>
          <p className="text-body text-ink-2 mt-3">
            Diese App ist auf eine Organisation beschränkt. Melde dich mit deinem WorkOS-Account an.
          </p>
          <Button onClick={() => signIn()} variant="accent" className="mt-6 w-full">
            Sign in with WorkOS
          </Button>
        </div>
      </div>
    )
  }

  return <TokenContext.Provider value={tokenGetter}>{children}</TokenContext.Provider>
}
