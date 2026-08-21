import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setDbForTests, type Db } from "./db/client.js"
import { appMeta, tenants } from "./db/schema.js"
import { createTestDb } from "./db/test-db.js"
import { updateScheduleSettings } from "./db/repos/schedules.js"
import { log } from "./lib/log.js"
import { invalidateTenantCache } from "./lib/tenant.js"

const listAllOrganizationsMock = vi.fn()
const listOrgFlagSlugsMock = vi.fn()

vi.mock("./lib/workos.js", () => ({
  listAllOrganizations: listAllOrganizationsMock,
  listOrgFlagSlugs: listOrgFlagSlugsMock,
  listUserOrgIds: vi.fn(),
}))

// Dynamisch NACH vi.mock — tenant-sync zieht lib/workos.
const { ORG_SYNC_FLAG_SLUG, _resetTenantSyncForTests, reconcileTenants } =
  await import("./tenant-sync.js")
const { isCronActive, stopScheduler } = await import("./integrations/scheduler.js")

let db: Db
let close: () => Promise<void>

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  log.info = () => {
    /* swallow */
  }
  log.warn = () => {
    /* swallow */
  }
  log.error = () => {
    /* swallow */
  }
})

afterAll(async () => {
  stopScheduler()
  setDbForTests(undefined)
  await close()
})

beforeEach(async () => {
  vi.stubEnv("WORKOS_API_KEY", "sk_test")
  vi.stubEnv("WORKOS_ORG_SYNC", "on")
  await db.delete(appMeta)
  await db.delete(tenants)
  _resetTenantSyncForTests()
  invalidateTenantCache()
  stopScheduler()
  listAllOrganizationsMock.mockReset()
  listOrgFlagSlugsMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Org-Welt der WorkOS-Mocks: [{ id, name, flags }] */
function mockWorld(orgs: { id: string; name: string; flags?: string[] }[]) {
  listAllOrganizationsMock.mockResolvedValue(orgs.map((o) => ({ id: o.id, name: o.name })))
  const byId = new Map(orgs.map((o) => [o.id, new Set(o.flags ?? [])]))
  listOrgFlagSlugsMock.mockImplementation((id: string) => {
    const flags = byId.get(id)
    if (!flags) throw new Error(`unbekannte Org im Test: ${id}`)
    return Promise.resolve(flags)
  })
}

async function tenantRows() {
  return db.select().from(tenants).orderBy(tenants.workosOrgId)
}

async function insertTenant(row: {
  workosOrgId: string
  displayName: string
  active?: boolean
  managedBy?: string
  deactivatedBy?: string | null
}) {
  const [r] = await db.insert(tenants).values(row).returning()
  return r
}

async function syncStatus() {
  const rows = await db.select().from(appMeta).where(eq(appMeta.key, "workos-org-sync"))
  return rows[0]?.value as
    | { lastSuccessAt: string | null; lastError: string | null; lastCounts: Record<string, number> }
    | undefined
}

describe("reconcileTenants", () => {
  it("provisioniert geflaggte Orgs als aktive sync-verwaltete Mandanten", async () => {
    mockWorld([
      { id: "org_a", name: "Alpha GmbH", flags: [ORG_SYNC_FLAG_SLUG] },
      { id: "org_b", name: "Beta GmbH" },
    ])

    await reconcileTenants()

    const rows = await tenantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workosOrgId: "org_a",
      displayName: "Alpha GmbH",
      active: true,
      managedBy: "workos-sync",
    })
    expect((await syncStatus())?.lastCounts).toEqual({
      created: 1,
      renamed: 0,
      reactivated: 0,
      deactivated: 0,
    })
    expect((await syncStatus())?.lastError).toBeNull()
  })

  it("zieht Umbenennungen für sync-verwaltete Zeilen nach", async () => {
    await insertTenant({
      workosOrgId: "org_a",
      displayName: "Alt GmbH",
      managedBy: "workos-sync",
    })
    mockWorld([{ id: "org_a", name: "Neu GmbH", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()

    expect((await tenantRows())[0].displayName).toBe("Neu GmbH")
  })

  it("fasst manuell verwaltete Zeilen NIE an — auch nicht bei gesetztem Flag", async () => {
    await insertTenant({ workosOrgId: "org_a", displayName: "Manuell GmbH" })
    mockWorld([{ id: "org_a", name: "Anderer Name", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()

    expect((await tenantRows())[0]).toMatchObject({
      displayName: "Manuell GmbH",
      active: true,
      managedBy: "manual",
    })
  })

  it("deaktiviert erst nach zwei aufeinanderfolgenden Läufen ohne Flag", async () => {
    await insertTenant({
      workosOrgId: "org_a",
      displayName: "Alpha",
      managedBy: "workos-sync",
    })
    await insertTenant({
      workosOrgId: "org_keep",
      displayName: "Keep",
      managedBy: "workos-sync",
    })
    mockWorld([
      { id: "org_a", name: "Alpha" },
      { id: "org_keep", name: "Keep", flags: [ORG_SYNC_FLAG_SLUG] },
    ])

    await reconcileTenants()
    let rows = await tenantRows()
    expect(rows.find((r) => r.workosOrgId === "org_a")?.active).toBe(true)

    await reconcileTenants()
    rows = await tenantRows()
    const a = rows.find((r) => r.workosOrgId === "org_a")
    expect(a?.active).toBe(false)
    expect(a?.deactivatedBy).toBe("workos-sync")
    expect(rows.find((r) => r.workosOrgId === "org_keep")?.active).toBe(true)
    expect((await syncStatus())?.lastCounts.deactivated).toBe(1)
  })

  it("Flag-Flackern (weg und wieder da) deaktiviert nie", async () => {
    await insertTenant({
      workosOrgId: "org_a",
      displayName: "Alpha",
      managedBy: "workos-sync",
    })
    mockWorld([{ id: "org_a", name: "Alpha" }])
    await reconcileTenants()

    mockWorld([{ id: "org_a", name: "Alpha", flags: [ORG_SYNC_FLAG_SLUG] }])
    await reconcileTenants()

    mockWorld([{ id: "org_a", name: "Alpha" }])
    await reconcileTenants()

    expect((await tenantRows())[0].active).toBe(true)
  })

  it("Circuit-Breaker: mehr als 2 fällige Deaktivierungen brechen den Lauf ab", async () => {
    for (const n of ["a", "b", "c"]) {
      await insertTenant({
        workosOrgId: `org_${n}`,
        displayName: n,
        managedBy: "workos-sync",
      })
    }
    await insertTenant({
      workosOrgId: "org_keep",
      displayName: "Keep",
      managedBy: "workos-sync",
    })
    mockWorld([{ id: "org_keep", name: "Keep", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()
    await reconcileTenants()

    const rows = await tenantRows()
    expect(rows.filter((r) => r.active)).toHaveLength(4)
    expect((await syncStatus())?.lastError).toMatch(/Circuit-Breaker/)
  })

  it("Sanity-Check: Liste ohne jede bekannte Org bricht VOR jeder Mutation ab", async () => {
    await insertTenant({
      workosOrgId: "org_known",
      displayName: "Bekannt",
      managedBy: "workos-sync",
    })
    // Fremdes Environment: nur unbekannte Orgs, sogar geflaggt.
    mockWorld([{ id: "org_foreign", name: "Fremd", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()
    await reconcileTenants()

    const rows = await tenantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].active).toBe(true)
    expect((await syncStatus())?.lastError).toMatch(/bekannte Org/)
  })

  it("Enumeration-Fehler ⇒ kein einziger Schreibzugriff, lastError gesetzt", async () => {
    await insertTenant({
      workosOrgId: "org_a",
      displayName: "Alpha",
      managedBy: "workos-sync",
    })
    listAllOrganizationsMock.mockRejectedValue(new Error("WorkOS /organizations HTTP 500"))

    await reconcileTenants()

    expect((await tenantRows())[0].active).toBe(true)
    expect((await syncStatus())?.lastError).toMatch(/HTTP 500/)
    expect((await syncStatus())?.lastSuccessAt).toBeNull()
  })

  it("reaktiviert nur eigene Deaktivierungen und startet die Crons neu", async () => {
    const row = await insertTenant({
      workosOrgId: "org_a",
      displayName: "Alpha",
      active: false,
      managedBy: "workos-sync",
      deactivatedBy: "workos-sync",
    })
    await updateScheduleSettings(row.id, "dimacon-clockin", {
      enabled: true,
      cron: "0 6 * * *",
      timezone: "Europe/Berlin",
    })
    mockWorld([{ id: "org_a", name: "Alpha", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()

    const after = (await tenantRows())[0]
    expect(after.active).toBe(true)
    expect(after.deactivatedBy).toBeNull()
    expect(isCronActive(row.id, "dimacon-clockin")).toBe(true)
  })

  it("Ops-Not-Aus bleibt: manuell deaktivierte sync-Zeile wird NICHT reaktiviert", async () => {
    await insertTenant({
      workosOrgId: "org_a",
      displayName: "Alpha",
      active: false,
      managedBy: "workos-sync",
      deactivatedBy: null,
    })
    mockWorld([{ id: "org_a", name: "Alpha", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()

    expect((await tenantRows())[0].active).toBe(false)
  })

  it("org_dev zählt nicht als bekannte Org und wird nie angefasst", async () => {
    await insertTenant({ workosOrgId: "org_dev", displayName: "Entwicklung (lokal)" })
    mockWorld([{ id: "org_new", name: "Neu GmbH", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()

    const rows = await tenantRows()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.workosOrgId === "org_dev")).toMatchObject({
      active: true,
      managedBy: "manual",
    })
    expect(rows.find((r) => r.workosOrgId === "org_new")).toMatchObject({
      active: true,
      managedBy: "workos-sync",
    })
  })

  it("zeitlich ungetrennte Läufe zählen die Bestätigung nicht doppelt (Boot-Burst)", async () => {
    _resetTenantSyncForTests(60_000)
    await insertTenant({
      workosOrgId: "org_a",
      displayName: "Alpha",
      managedBy: "workos-sync",
    })
    await insertTenant({
      workosOrgId: "org_keep",
      displayName: "Keep",
      managedBy: "workos-sync",
    })
    mockWorld([
      { id: "org_a", name: "Alpha" },
      { id: "org_keep", name: "Keep", flags: [ORG_SYNC_FLAG_SLUG] },
    ])

    // Boot-Lauf + sofortiger Cron-Tick: zweiter Durchgang liegt innerhalb
    // des Spacing-Fensters — Streak darf nur EINMAL zählen.
    await reconcileTenants()
    await reconcileTenants()
    await reconcileTenants()

    expect((await tenantRows()).find((r) => r.workosOrgId === "org_a")?.active).toBe(true)
  })

  it("Fehler beim Flag-Abruf einer Org ⇒ kompletter Lauf ohne Mutationen", async () => {
    await insertTenant({
      workosOrgId: "org_streak",
      displayName: "Streak",
      managedBy: "workos-sync",
    })
    mockWorld([
      { id: "org_streak", name: "Streak" },
      { id: "org_new", name: "Neu", flags: [ORG_SYNC_FLAG_SLUG] },
    ])
    listOrgFlagSlugsMock.mockRejectedValue(new Error("WorkOS feature-flags HTTP 500"))

    await reconcileTenants()
    await reconcileTenants()

    const rows = await tenantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].active).toBe(true)
    expect((await syncStatus())?.lastError).toMatch(/HTTP 500/)
    expect((await syncStatus())?.lastSuccessAt).toBeNull()
  })

  it("genau 2 fällige Deaktivierungen laufen durch (Breaker-Grenze)", async () => {
    for (const n of ["a", "b"]) {
      await insertTenant({
        workosOrgId: `org_${n}`,
        displayName: n,
        managedBy: "workos-sync",
      })
    }
    await insertTenant({
      workosOrgId: "org_keep",
      displayName: "Keep",
      managedBy: "workos-sync",
    })
    mockWorld([{ id: "org_keep", name: "Keep", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()
    await reconcileTenants()

    const rows = await tenantRows()
    expect(rows.filter((r) => !r.active)).toHaveLength(2)
    expect(rows.filter((r) => !r.active).every((r) => r.deactivatedBy === "workos-sync")).toBe(true)
    expect((await syncStatus())?.lastError).toBeNull()
    expect((await syncStatus())?.lastCounts.deactivated).toBe(2)
  })

  it("selbst wegen Org-Löschung deaktivierte Zeilen sind keine Sanity-Anker (kein Dauer-Wedge)", async () => {
    await insertTenant({
      workosOrgId: "org_gone",
      displayName: "Weg",
      active: false,
      managedBy: "workos-sync",
      deactivatedBy: "workos-sync",
    })
    // Org-Liste kennt org_gone nicht mehr — trotzdem muss eine neu
    // geflaggte Org provisioniert werden können.
    mockWorld([{ id: "org_new", name: "Neu GmbH", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()

    const rows = await tenantRows()
    expect(rows.find((r) => r.workosOrgId === "org_new")).toMatchObject({
      active: true,
      managedBy: "workos-sync",
    })
    expect((await syncStatus())?.lastError).toBeNull()
  })

  it("ist ohne WORKOS_ORG_SYNC=on ein No-op", async () => {
    vi.stubEnv("WORKOS_ORG_SYNC", "")
    mockWorld([{ id: "org_a", name: "Alpha", flags: [ORG_SYNC_FLAG_SLUG] }])

    await reconcileTenants()

    expect(await tenantRows()).toHaveLength(0)
    expect(listAllOrganizationsMock).not.toHaveBeenCalled()
  })
})
