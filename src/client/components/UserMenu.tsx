import { useAuth } from "@workos-inc/authkit-react"

export function UserMenu() {
  const { user, signOut } = useAuth()
  if (!user) return null
  const name = user.firstName ?? user.email
  return (
    <div className="flex items-center gap-3">
      <span className="text-ink-3 font-mono text-[11px] tracking-[0.18em] uppercase max-md:hidden">
        {name}
      </span>
      <button
        type="button"
        onClick={() => signOut()}
        className="text-ink-3 hover:text-ink font-mono text-[11px] tracking-[0.18em] uppercase transition-colors"
      >
        Sign out
      </button>
    </div>
  )
}
