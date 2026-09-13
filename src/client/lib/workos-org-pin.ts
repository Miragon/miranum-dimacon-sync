import { WORKOS_CLIENT_ID } from "#/lib/auth-flag"

/**
 * Schlüssel, unter dem authkit-js die aktive Organisation im sessionStorage
 * hält. PRIVATES DETAIL des Pakets — hier gepinnt auf authkit-js 0.20.0
 * (`orgIdKey()` in `src/create-client.ts`).
 */
function orgIdKey(clientId: string): string {
  return `workos-org-id:${clientId}`
}

/**
 * Schreibt die erwartete Organisation zurück, BEVOR ein Refresh erzwungen wird.
 *
 * LOAD-BEARING für den Mandanten-Switcher: authkit-js räumt beim
 * `RefreshError` — das ist JEDE nicht-ok-JSON-Antwort des Refresh-Endpunkts,
 * also auch ein transienter 429/5xx — Memory-Token UND diesen Schlüssel ab und
 * feuert erst danach `onRefreshFailure`. Der anschließend erzwungene Refresh
 * hätte sonst keine Org-Quelle mehr und ginge OHNE `organization_id` raus;
 * WorkOS antwortet dann mit einem Token für eine andere Organisation und die
 * UI arbeitete still im falschen Mandanten weiter.
 *
 * Der Aufruf ist absichtlich idempotent und still: schlägt er fehl (Storage
 * gesperrt, Schlüsselname in einer neuen authkit-Version umbenannt), fängt
 * `isSameOrganization` die Abweichung weiterhin ab — der Schutz degradiert
 * dann von „verhindert" zu „erkennt", nicht zu „still falsch".
 */
export function pinOrganization(organizationId: string | null): void {
  if (!organizationId || !WORKOS_CLIENT_ID) return
  try {
    sessionStorage.setItem(orgIdKey(WORKOS_CLIENT_ID), organizationId)
  } catch {
    /* Storage gesperrt (Private Mode, Quota) — der Vergleich bleibt als Netz. */
  }
}
