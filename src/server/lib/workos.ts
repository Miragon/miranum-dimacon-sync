import { z } from "zod"
import { env } from "./env.js"
import { formatError } from "./errors.js"
import { log } from "./log.js"

/**
 * Org-Mitgliedschaften eines Users über die WorkOS User-Management-API.
 * Braucht den server-only `WORKOS_API_KEY` (nie loggen, nie als VITE_*
 * exportieren); `userId` kommt IMMER aus dem verifizierten JWT-`sub`,
 * nie aus Client-Input. Ohne Key ist das Feature aus (undefined, kein Log);
 * jeder API-Fehler wird zu undefined + log.warn — der Aufrufer fällt dann
 * fail-closed auf den eigenen Mandanten zurück (Idiom wie verifyAccessToken).
 */

const CACHE_TTL_MS = 60_000
const TIMEOUT_MS = 5_000
const MAX_PAGES = 10

// Tolerant gegenüber zusätzlichen Feldern (zod strippt Unbekanntes).
const MembershipsPage = z.object({
  data: z.array(z.object({ organization_id: z.string(), status: z.string().optional() })),
  list_metadata: z.object({ after: z.string().nullish() }).nullish(),
})

const cache = new Map<string, { orgIds: Set<string>; at: number }>()

export async function listUserOrgIds(userId: string): Promise<Set<string> | undefined> {
  const apiKey = env.workos.apiKey()
  if (!apiKey) return undefined

  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.orgIds

  try {
    const orgIds = new Set<string>()
    let after: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL("https://api.workos.com/user_management/organization_memberships")
      url.searchParams.set("user_id", userId)
      url.searchParams.set("statuses", "active")
      url.searchParams.set("limit", "100")
      if (after) url.searchParams.set("after", after)

      const res = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`WorkOS memberships HTTP ${res.status}`)

      const body = MembershipsPage.parse(await res.json())
      for (const m of body.data) {
        // statuses=active ist gesetzt UND API-Default — der Filter hier ist
        // nur der dritte Gurt, falls WorkOS den Parameter je ignoriert.
        if (m.status === undefined || m.status === "active") orgIds.add(m.organization_id)
      }
      after = body.list_metadata?.after ?? undefined
      if (!after) break
    }

    // Nur Erfolge cachen — nach einem WorkOS-Ausfall erholt sich der
    // Switcher sofort statt 60 s lang leer zu bleiben.
    cache.set(userId, { orgIds, at: Date.now() })
    return orgIds
  } catch (err) {
    log.warn("workos membership lookup failed — switcher auf aktiven Mandanten begrenzt", {
      userId,
      error: formatError(err),
    })
    return undefined
  }
}

/** Nur für Tests. */
export function _resetWorkosCacheForTests(): void {
  cache.clear()
}

// ─── Org-Sync-Fetcher (tenant-sync.ts) ────────────────────────────────────
// Bewusst FAIL-LOUD (werfen statt warn+undefined wie listUserOrgIds): der
// Reconcile darf eine unvollständige/fehlgeschlagene Liste NIE als "Org ist
// weg" lesen — das wäre der direkte Weg in die Massen-Deaktivierung.

export interface WorkOSOrganization {
  id: string
  name: string
}

const OrganizationsPage = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() })),
  list_metadata: z.object({ after: z.string().nullish() }).nullish(),
})

const OrgFlagsPage = z.object({
  data: z.array(z.object({ slug: z.string() })),
  list_metadata: z.object({ after: z.string().nullish() }).nullish(),
})

const ORG_PAGE_CAP = 20

function requireApiKey(): string {
  const apiKey = env.workos.apiKey()
  if (!apiKey) throw new Error("WORKOS_API_KEY ist nicht gesetzt")
  return apiKey
}

async function fetchListPage(url: URL, apiKey: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`WorkOS ${url.pathname} HTTP ${res.status}`)
  return res.json()
}

/** Vollständige Org-Liste des Environments; wirft auch beim Page-Cap. */
export async function listAllOrganizations(): Promise<WorkOSOrganization[]> {
  const apiKey = requireApiKey()
  const orgs: WorkOSOrganization[] = []
  let after: string | undefined
  for (let page = 0; ; page++) {
    if (page >= ORG_PAGE_CAP) {
      throw new Error(`WorkOS-Org-Liste über ${ORG_PAGE_CAP} Seiten — Abbruch (unvollständig)`)
    }
    const url = new URL("https://api.workos.com/organizations")
    url.searchParams.set("limit", "100")
    if (after) url.searchParams.set("after", after)
    const body = OrganizationsPage.parse(await fetchListPage(url, apiKey))
    orgs.push(...body.data)
    after = body.list_metadata?.after ?? undefined
    if (!after) break
  }
  return orgs
}

/** Aktivierte Feature-Flag-Slugs einer Org (GET /organizations/:id/feature-flags). */
export async function listOrgFlagSlugs(orgId: string): Promise<Set<string>> {
  const apiKey = requireApiKey()
  const slugs = new Set<string>()
  let after: string | undefined
  for (let page = 0; ; page++) {
    if (page >= ORG_PAGE_CAP) {
      throw new Error(`WorkOS-Flag-Liste über ${ORG_PAGE_CAP} Seiten — Abbruch (unvollständig)`)
    }
    const url = new URL(
      `https://api.workos.com/organizations/${encodeURIComponent(orgId)}/feature-flags`,
    )
    url.searchParams.set("limit", "100")
    if (after) url.searchParams.set("after", after)
    const body = OrgFlagsPage.parse(await fetchListPage(url, apiKey))
    for (const flag of body.data) slugs.add(flag.slug)
    after = body.list_metadata?.after ?? undefined
    if (!after) break
  }
  return slugs
}
