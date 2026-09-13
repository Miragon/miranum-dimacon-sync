import { useAuth } from "@workos-inc/authkit-react"
import { useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
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
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  if (!tenantCtx) return null
  const { tenant, tenants, organizationId } = tenantCtx
  const switchable = tenants.filter((t) => t.orgId !== organizationId)

  const chipClass =
    "border-rule text-ink-2 border px-2 py-1 font-mono text-[11px] tracking-[0.18em] uppercase"

  // Nur ein Mandant: nichts zum Wechseln, also auch kein Menü.
  if (switchable.length === 0) return <span className={chipClass}>Mandant · {tenant.name}</span>

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
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`${chipClass} hover:border-ink hover:text-ink focus-visible:outline-mn-accent transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2`}
      >
        Mandant · {tenant.name} ▾
      </DropdownMenuTrigger>
      {/* Ersetzt ein handgebautes Popover: Escape, Pfeiltasten, Focus-Rückgabe
          und aria-expanded kommen jetzt aus dem Primitive statt zu fehlen. */}
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel className="text-ink-3 border-rule border-b font-mono text-[10px] tracking-[0.18em] uppercase">
          Mandant wechseln
        </DropdownMenuLabel>
        {switchable.map((t) => (
          <DropdownMenuItem
            key={t.orgId}
            disabled={switching !== null}
            onClick={() => void switchTo(t.orgId)}
            className="font-mono text-[11px] tracking-[0.1em]"
          >
            {switching === t.orgId ? "wechsle …" : t.name}
          </DropdownMenuItem>
        ))}
        {switchError ? (
          <p className="text-mn-accent border-rule border-t px-3 py-2 font-mono text-[10px]">
            {switchError}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
