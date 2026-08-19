import { useAuth } from "@workos-inc/authkit-react"
import { useEffect, useRef, useState } from "react"
import { useTenant } from "#/lib/tenant"

export function UserMenu() {
  const { user, signOut } = useAuth()
  if (!user) return null
  const name = user.firstName ?? user.email
  return (
    <div className="flex items-center gap-3">
      <TenantChip />
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

/**
 * Aktiver Mandant als Mono-Chip; bei mehreren freigeschalteten Mandanten ein
 * Popover zum Wechseln. switchToOrganization holt ein Token für die Ziel-Org;
 * der harte Reload ist die State-Invalidierung — alle Screens fetchen on mount.
 */
function TenantChip() {
  const tenantCtx = useTenant()
  const { switchToOrganization } = useAuth()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [open])

  if (!tenantCtx) return null
  const { tenant, tenants, organizationId } = tenantCtx
  const switchable = tenants.filter((t) => t.orgId !== organizationId)

  const chip = (
    <span className="border-rule text-ink-2 border px-2 py-1 font-mono text-[11px] tracking-[0.18em] uppercase">
      Mandant · {tenant.name}
    </span>
  )

  if (switchable.length === 0) return chip

  async function switchTo(orgId: string) {
    setSwitching(orgId)
    setSwitchError(null)
    try {
      await switchToOrganization({ organizationId: orgId })
      window.location.assign("/")
    } catch (err) {
      // Das SDK leitet bei Fehlern ggf. selbst zur Hosted-Login-Seite um;
      // bleibt es hier, zeigen wir den Fehler inline.
      setSwitching(null)
      setSwitchError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="border-rule text-ink-2 hover:border-ink hover:text-ink border px-2 py-1 font-mono text-[11px] tracking-[0.18em] uppercase transition-colors"
      >
        Mandant · {tenant.name} ▾
      </button>
      {open ? (
        <div className="border-rule bg-paper absolute top-full right-0 z-20 mt-2 min-w-[220px] border">
          <p className="text-ink-3 border-rule border-b px-3 py-2 font-mono text-[10px] tracking-[0.18em] uppercase">
            Mandant wechseln
          </p>
          <ul className="divide-rule divide-y">
            {switchable.map((t) => (
              <li key={t.orgId}>
                <button
                  type="button"
                  disabled={switching !== null}
                  onClick={() => void switchTo(t.orgId)}
                  className="text-ink hover:bg-paper-3 block w-full px-3 py-2 text-left font-mono text-[11px] tracking-[0.1em] transition-colors disabled:opacity-50"
                >
                  {switching === t.orgId ? "wechsle …" : t.name}
                </button>
              </li>
            ))}
          </ul>
          {switchError ? (
            <p className="text-mn-accent border-rule border-t px-3 py-2 font-mono text-[10px]">
              {switchError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
