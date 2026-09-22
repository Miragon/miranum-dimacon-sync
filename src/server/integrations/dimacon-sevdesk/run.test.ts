import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"
import type { IntegrationRunContext } from "../types.js"
import type { CustomerSyncResult } from "./types.js"

const updateCustomerMock = vi.fn()
const loadAllCustomersMock = vi.fn()
const loadMappingContextMock = vi.fn()
const loadIndexMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: { updateCustomer: updateCustomerMock },
}))
vi.mock("../shared/dimacon.js", () => ({
  loadAllCustomers: loadAllCustomersMock,
}))
vi.mock("../shared/mapping-context.js", () => ({
  loadMappingContext: loadMappingContextMock,
}))
vi.mock("./contact-index.js", async (importOriginal) => ({
  // Index-Klasse bleibt echt (der Aligner registriert Creates darin),
  // nur der Loader wird kontrolliert.
  ...((await importOriginal()) as Record<string, unknown>),
  loadSevdeskContactIndex: loadIndexMock,
}))

const { runDimaconSevdeskSync } = await import("./run.js")
const { SevdeskContactIndex } = await import("./contact-index.js")

const noop = () => {
  /* silent */
}
const silentLog: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLog,
}

const sevGet = vi.fn()
const sevPost = vi.fn()

function testCtx(): IntegrationRunContext {
  return {
    tenantId: "tenant-test",
    trigger: "manual",
    clients: {
      tenantId: "tenant-test",
      clockin: async () => ({ kind: "clockin" }) as never,
      dimacon: async () => ({ kind: "dimacon" }) as never,
      lexoffice: async () => ({ kind: "lexoffice" }) as never,
      sevdesk: async () => ({ get: sevGet, post: sevPost }) as never,
    },
    getFieldMapping: async () => undefined,
    log: silentLog,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  updateCustomerMock.mockResolvedValue({})
  loadAllCustomersMock.mockResolvedValue([
    { id: "cust-1", customerNumber: "D-100", name: "Muster GmbH" },
  ])
  loadMappingContextMock.mockResolvedValue(new Map())
  loadIndexMock.mockResolvedValue(
    new SevdeskContactIndex([{ id: "sev-1", name: "Muster GmbH", customerNumber: "S-200" }]),
  )
  sevGet.mockResolvedValue({ objects: [] })
  sevPost.mockResolvedValue({ objects: { id: "sev-new" } })
})

describe("runDimaconSevdeskSync", () => {
  it("runs with {} input (scheduler contract) — both steps default to on", async () => {
    const result = (await runDimaconSevdeskSync(testCtx(), {})) as CustomerSyncResult

    expect(result.steps).toEqual({ createContacts: true, alignNumbers: true })
    expect(result.customers).toHaveLength(1)
    expect(result.customers[0].status).toBe("aligned")
    expect(updateCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("does nothing when all steps are disabled", async () => {
    const result = await runDimaconSevdeskSync(testCtx(), {
      steps: { createContacts: false, alignNumbers: false },
    })

    expect(result.customers).toHaveLength(0)
    expect(loadAllCustomersMock).not.toHaveBeenCalled()
  })

  it("disables contact creation when the mapping fails to load — alignment keeps running", async () => {
    loadMappingContextMock.mockRejectedValue(new Error("attribute API down"))

    const result = (await runDimaconSevdeskSync(testCtx(), {})) as CustomerSyncResult

    expect(result.steps.createContacts).toBe(false)
    expect(result.errors.some((e) => e.scope === "mapping")).toBe(true)
    // Der vorhandene Kontakt wird weiterhin aligned …
    expect(result.customers[0].status).toBe("aligned")
    // … aber ein fehlender Kunde würde nicht angelegt (kein POST).
    expect(sevPost).not.toHaveBeenCalled()
  })

  it("falls back to per-customer lookups when the contact index fails", async () => {
    loadIndexMock.mockRejectedValue(new Error("pagination broke"))
    sevGet.mockResolvedValue({
      objects: [{ id: "sev-1", name: "Muster GmbH", customerNumber: "S-200" }],
    })

    const result = (await runDimaconSevdeskSync(testCtx(), {})) as CustomerSyncResult

    expect(result.errors.some((e) => e.scope === "customers")).toBe(true)
    expect(result.customers[0].status).toBe("aligned")
    expect(sevGet).toHaveBeenCalled()
  })

  it("records a failed row per customer instead of aborting the run", async () => {
    loadAllCustomersMock.mockResolvedValue([
      { id: "cust-1", customerNumber: "D-100", name: "Muster GmbH" },
      { id: "cust-2", customerNumber: "D-200", name: "Beispiel AG" },
    ])
    loadIndexMock.mockResolvedValue(
      new SevdeskContactIndex([
        { id: "sev-1", name: "Muster GmbH", customerNumber: "S-200" },
        { id: "sev-2", name: "Beispiel AG", customerNumber: "S-300" },
      ]),
    )
    // Deterministisch je Kunde statt mockRejectedValueOnce: withRetry würde
    // einen einmaligen Fehler wegwiederholen und den Once-Queue verschieben.
    updateCustomerMock.mockImplementation((opts: { path: { customerId: string } }) =>
      opts.path.customerId === "cust-1"
        ? Promise.reject(new Error("dimacon 400 bad request"))
        : Promise.resolve({}),
    )

    const result = (await runDimaconSevdeskSync(testCtx(), {})) as CustomerSyncResult

    const statuses = result.customers.map((c) => c.status).sort()
    expect(statuses).toEqual(["aligned", "failed"])
    expect(result.errors.some((e) => e.scope === "customer")).toBe(true)
  })

  it("stops after the customer load fails", async () => {
    loadAllCustomersMock.mockRejectedValue(new Error("dimacon down"))

    const result = (await runDimaconSevdeskSync(testCtx(), {})) as CustomerSyncResult

    expect(result.customers).toHaveLength(0)
    expect(result.errors).toEqual([{ scope: "customers", message: "dimacon down" }])
    expect(loadIndexMock).not.toHaveBeenCalled()
  })
})
