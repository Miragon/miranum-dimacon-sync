import { Cron } from "croner"
import { getDb } from "./db/client.js"
import { appMeta } from "./db/schema.js"
import {
  DEV_TENANT_ORG_ID,
  SYNC_MANAGED,
  deactivateSyncTenant,
  insertSyncTenant,
  listAllTenants,
  reactivateSyncTenant,
  renameSyncTenant,
} from "./db/repos/tenants.js"
import { integrations } from "./integrations/registry.js"
import { startTenantIntegrationCron } from "./integrations/scheduler.js"
import { env } from "./lib/env.js"
import { formatError } from "./lib/errors.js"
import { log } from "./lib/log.js"
import { invalidateTenantCache } from "./lib/tenant.js"
import { listAllOrganizations, listOrgFlagSlugs } from "./lib/workos.js"

/**
 * Org-Sync: WorkOS-Orgs mit aktiviertem Feature-Flag werden automatisch als
 * Mandanten provisioniert (PULL-only Voll-Reconcile — kein neuer offener
 * HTTP-Endpoint, die tenants-Tabelle bleibt ausschließlich in-process
 * beschrieben). Schutznetze gegen die zwei Katastrophen-Szenarien:
 *
 * 1. Massen-Deaktivierung durch kaputte/fremde Org-Liste (falscher API-Key
 *    liefert ERFOLGREICH die Orgs eines anderen Environments!): Sanity-Check
 *    (Liste muss mindestens eine bekannte Org enthalten) bricht VOR jeder
 *    Mutation ab; Deaktivierung zusätzlich erst nach CONFIRMATIONS_REQUIRED
 *    zeitlich getrennten Läufen ohne Flag (MIN_CONFIRMATION_SPACING_MS —
 *    dicht aufeinanderfolgende Läufe zählen nicht doppelt) und mit
 *    Circuit-Breaker: mehr als MAX_DEACTIVATIONS_PER_RUN fällige
 *    Deaktivierungen (oder >50 % der aktiven sync-Mandanten bei >3) brechen
 *    den KOMPLETTEN Lauf ab (0 ausgeführt), bis jemand manuell prüft.
 * 2. Ops-Not-Aus darf nie stillschweigend rückgängig werden: alle Mutationen
 *    sind Compare-and-Swap (Guards in der WHERE-Klausel, s. repos/tenants.ts);
 *    reaktiviert werden NUR Zeilen mit deactivated_by='workos-sync'.
 *
 * Manuell verwaltete Zeilen (managed_by='manual', inkl. org_dev und aller
 * per Ops-Script angelegten Mandanten) werden in keiner Weise angefasst.
 */

export const ORG_SYNC_FLAG_SLUG = "dimacon-sync"
const META_KEY = "workos-org-sync"
const INTERVAL_CRON = "*/2 * * * *"
const DAILY_CRON = "17 6 * * *"
const MAX_DEACTIVATIONS_PER_RUN = 2
const CONFIRMATIONS_REQUIRED = 2
const STALENESS_LIMIT_MS = 24 * 60 * 60 * 1000

// Zwei "Flag fehlt"-Beobachtungen gelten nur als unabhängig, wenn zwischen
// ihnen echte Zeit liegt — sonst würde ein Boot-Lauf + erster Cron-Tick
// (Sekunden auseinander) die 2-Läufe-Bestätigung zu einem Burst kollabieren.
let minConfirmationSpacingMs = 90_000
let lastDeactivationPhaseAt = 0

export function orgSyncEnabled(): boolean {
  return Boolean(env.workos.apiKey()) && env.workos.orgSync()
}

// Aufeinanderfolgende "Flag fehlt"-Beobachtungen je Org-Id (in-memory:
// ein Prozess-Restart setzt den Zähler zurück und verzögert eine
// Deaktivierung schlimmstenfalls um einen weiteren Zyklus — gewollt konservativ).
const flagMissingStreak = new Map<string, number>()

// Latch: läuft bereits ein Reconcile, wird der Trigger verworfen — der
// nächste Cron-Tick (≤2 min) holt ihn nach. Bewusst KEINE sofortige
// Wiederholung (Burst würde die 2-Läufe-Bestätigung aushebeln).
let running = false

export async function reconcileTenants(): Promise<void> {
  if (!orgSyncEnabled()) return
  if (running) return
  running = true
  try {
    await runOnce()
  } finally {
    running = false
  }
}

async function runOnce(): Promise<void> {
  const startedAt = new Date().toISOString()
  const counts = { created: 0, renamed: 0, reactivated: 0, deactivated: 0 }
  let lastError: string | null = null

  try {
    // ── Enumeration (fail-loud: jeder Fehler bricht den ganzen Lauf ab) ──
    const orgs = await listAllOrganizations()
    const orgById = new Map(orgs.map((o) => [o.id, o]))

    const allTenants = await listAllTenants()
    const byOrgId = new Map(allTenants.map((t) => [t.workosOrgId, t]))

    // Sanity-Check VOR jeder Mutation: kennt die Liste keine einzige unserer
    // Orgs, ist sie nicht vertrauenswürdig — typisch Stage/Prod-Key-
    // Verwechslung. Anker sind nur Zeilen, deren Org-Existenz wir noch
    // erwarten: org_dev existiert nie in WorkOS, und Zeilen, die der Sync
    // selbst wegen fehlender Org deaktiviert hat, tragen kein Signal mehr
    // (sonst verkeilt sich der Sync dauerhaft, sobald alle Anker-Orgs
    // gelöscht wurden).
    const anchorTenants = allTenants.filter(
      (t) =>
        t.workosOrgId !== DEV_TENANT_ORG_ID &&
        !(t.active === false && t.deactivatedBy === SYNC_MANAGED),
    )
    if (anchorTenants.length > 0 && !anchorTenants.some((t) => orgById.has(t.workosOrgId))) {
      const expected = anchorTenants
        .slice(0, 3)
        .map((t) => t.workosOrgId)
        .join(", ")
      throw new Error(
        `Org-Liste enthält keine einzige bekannte Org (erwartet u. a.: ${expected}) — ` +
          "falsches WorkOS-Environment/API-Key oder Orgs gelöscht? Lauf abgebrochen",
      )
    }

    const flaggedOrgIds = new Set<string>()
    for (const org of orgs) {
      const slugs = await listOrgFlagSlugs(org.id)
      if (slugs.has(ORG_SYNC_FLAG_SLUG)) flaggedOrgIds.add(org.id)
    }

    // ── Create / Rename / Reactivate ──
    for (const orgId of flaggedOrgIds) {
      const org = orgById.get(orgId)!
      const existing = byOrgId.get(orgId)
      flagMissingStreak.delete(orgId)

      if (!existing) {
        const row = await insertSyncTenant({ workosOrgId: orgId, displayName: org.name })
        if (row) {
          counts.created++
          invalidateTenantCache(orgId)
          log.warn("org-sync: tenant auto-provisioned", { orgId, name: org.name })
        }
        continue
      }

      if (existing.managedBy !== SYNC_MANAGED) {
        log.warn("org-sync: Flag wirkungslos — Tenant ist manuell verwaltet", {
          orgId,
          tenant: existing.id,
        })
        continue
      }

      if (existing.displayName !== org.name && (await renameSyncTenant(existing.id, org.name))) {
        counts.renamed++
        invalidateTenantCache(orgId)
      }

      if (!existing.active && existing.deactivatedBy === SYNC_MANAGED) {
        if (await reactivateSyncTenant(existing.id)) {
          counts.reactivated++
          invalidateTenantCache(orgId)
          log.warn("org-sync: tenant reactivated", { orgId, tenant: existing.id })
          // Crons neu aufsetzen: listEnabledSchedules filtert auf aktive
          // Mandanten — nach Restart+Reaktivierung wären Zeitpläne sonst tot.
          // Fehler hier dürfen den Lauf nicht abbrechen (Tenant ist bereits
          // aktiv); der nächste erfolgreiche Settings-PUT oder Prozess-
          // Restart repariert verbleibende Slots.
          for (const def of integrations) {
            try {
              await startTenantIntegrationCron(existing.id, def.id)
            } catch (err) {
              log.error("org-sync: cron restart failed", {
                tenant: existing.id,
                integration: def.id,
                error: formatError(err),
              })
            }
          }
        }
      }
    }

    // ── Deactivate (nur hier, hinter allen Guards) ──
    // Zeitliche Trennung der Bestätigungs-Läufe: liegt der letzte
    // Deaktivierungs-Durchgang zu kurz zurück, bleibt die Phase (inkl.
    // Streak-Zählung) komplett aus.
    const now = Date.now()
    if (now - lastDeactivationPhaseAt < minConfirmationSpacingMs) return
    lastDeactivationPhaseAt = now

    const activeSync = allTenants.filter((t) => t.managedBy === SYNC_MANAGED && t.active)
    const candidates: { id: string; workosOrgId: string; reason: string }[] = []
    for (const t of activeSync) {
      if (flaggedOrgIds.has(t.workosOrgId)) continue
      const streak = (flagMissingStreak.get(t.workosOrgId) ?? 0) + 1
      flagMissingStreak.set(t.workosOrgId, streak)
      if (streak >= CONFIRMATIONS_REQUIRED) {
        candidates.push({
          id: t.id,
          workosOrgId: t.workosOrgId,
          reason: orgById.has(t.workosOrgId) ? "entflaggt" : "Org in WorkOS gelöscht",
        })
      }
    }
    if (
      candidates.length > MAX_DEACTIVATIONS_PER_RUN ||
      (activeSync.length > 3 && candidates.length * 2 > activeSync.length)
    ) {
      throw new Error(
        `Circuit-Breaker: ${candidates.length} von ${activeSync.length} aktiven ` +
          "sync-Mandanten wären zu deaktivieren — kompletter Lauf abgebrochen (0 ausgeführt), " +
          "bitte manuell prüfen",
      )
    }
    for (const c of candidates) {
      if (await deactivateSyncTenant(c.id)) {
        counts.deactivated++
        invalidateTenantCache(c.workosOrgId)
        log.error("org-sync: tenant deactivated", {
          orgId: c.workosOrgId,
          tenant: c.id,
          reason: c.reason,
        })
      }
      flagMissingStreak.delete(c.workosOrgId)
    }
  } catch (err) {
    lastError = formatError(err)
    log.error("org-sync reconcile failed", { error: lastError })
  } finally {
    await writeStatus(startedAt, lastError, counts)
  }
}

interface SyncStatus {
  lastAttemptAt: string
  lastSuccessAt: string | null
  lastError: string | null
  lastCounts: Record<string, number>
}

async function readStatus(): Promise<SyncStatus | undefined> {
  const db = getDb()
  const rows = await db.select().from(appMeta)
  const row = rows.find((r) => r.key === META_KEY)
  return row?.value as SyncStatus | undefined
}

async function writeStatus(
  startedAt: string,
  lastError: string | null,
  lastCounts: Record<string, number>,
): Promise<void> {
  try {
    const previous = await readStatus()
    const value: SyncStatus = {
      lastAttemptAt: startedAt,
      lastSuccessAt: lastError ? (previous?.lastSuccessAt ?? null) : startedAt,
      lastError,
      lastCounts,
    }
    await getDb()
      .insert(appMeta)
      .values({ key: META_KEY, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value } })
  } catch (err) {
    log.error("org-sync: status write failed", { error: formatError(err) })
  }
}

let intervalCron: Cron | undefined
let dailyCron: Cron | undefined

/** Nach Boot-Lock/Seed + startScheduler aufrufen (Reihenfolge load-bearing). */
export function startTenantSync(): void {
  if (!orgSyncEnabled()) {
    log.info("org-sync disabled", {
      hint: "WORKOS_API_KEY + WORKOS_ORG_SYNC=on setzen, um Orgs mit Feature-Flag automatisch zu provisionieren",
    })
    return
  }
  log.info("org-sync enabled", { flag: ORG_SYNC_FLAG_SLUG, interval: INTERVAL_CRON })
  void reconcileTenants()
  intervalCron = new Cron(INTERVAL_CRON, { protect: true }, () => reconcileTenants())
  dailyCron = new Cron(DAILY_CRON, { protect: true }, async () => {
    await reconcileTenants()
    const status = await readStatus().catch(() => undefined)
    const lastSuccess = status?.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0
    if (Date.now() - lastSuccess > STALENESS_LIMIT_MS) {
      log.error("org-sync: kein erfolgreicher Reconcile seit über 24 h", {
        lastSuccessAt: status?.lastSuccessAt ?? null,
        lastError: status?.lastError ?? null,
      })
    }
  })
}

export function stopTenantSync(): void {
  intervalCron?.stop()
  dailyCron?.stop()
  intervalCron = undefined
  dailyCron = undefined
}

/** Nur für Tests. */
export function _resetTenantSyncForTests(confirmationSpacingMs = 0): void {
  flagMissingStreak.clear()
  running = false
  lastDeactivationPhaseAt = 0
  minConfirmationSpacingMs = confirmationSpacingMs
}
