import { createContext, useContext } from "react"

export interface TenantInfo {
  id: string
  name: string
}

export interface TenantListEntry {
  /** WorkOS-`org_…`-Id — switchToOrganization() braucht genau diese. */
  orgId: string
  name: string
}

export interface TenantContextValue {
  tenant: TenantInfo
  tenants: TenantListEntry[]
  organizationId: string | null
}

export const TenantContext = createContext<TenantContextValue | null>(null)

/** Aktiver Mandant — nur unterhalb des TenantGate verfügbar (Auth an). */
export function useTenant(): TenantContextValue | null {
  return useContext(TenantContext)
}
