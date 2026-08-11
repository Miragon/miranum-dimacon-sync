import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"

const searchForCustomersMock = vi.fn()
const createCustomerMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: { searchForCustomers: searchForCustomersMock, createCustomer: createCustomerMock },
}))

const { CustomerSyncer } = await import("./customers.js")
const { log } = await import("../../lib/log.js")

const silentLog = log.child({ test: true })
;(silentLog as unknown as { info: () => void }).info = () => {
  /* swallow */
}

const stubClient = {} as never

const customer: DimaconCustomerInfo = {
  id: "cust-1",
  customerNumber: "D-100",
  name: "Muster GmbH",
  street: "Musterweg 1",
  zipCity: "80331 München",
}

beforeEach(() => {
  searchForCustomersMock.mockReset()
  createCustomerMock.mockReset()
})

describe("CustomerSyncer (ohne Lexware)", () => {
  it("maps an existing clockin customer without creating", async () => {
    searchForCustomersMock.mockResolvedValue({
      data: [{ id: 7, company: "Muster GmbH", identifier: "D-100" }],
    })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping).toEqual({
      dimaconId: "cust-1",
      clockinId: 7,
      number: "D-100",
      name: "Muster GmbH",
    })
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("creates with the dimacon customer number as identifier", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping.clockinId).toBe(42)
    expect(mapping.number).toBe("D-100")
    expect(createCustomerMock.mock.calls[0][0]).toMatchObject({
      body: { company: "Muster GmbH", identifier: "D-100", zip: "80331", city: "München" },
    })
  })

  it("falls back to a name lookup when the dimacon number changed (no duplicate)", async () => {
    // Szenario: dimacon-lexoffice hat die Dimacon-Nummer D-100 → L-200
    // geändert, der Clockin-Kunde existiert aber noch mit identifier=D-100.
    searchForCustomersMock
      .mockResolvedValueOnce({ data: [] }) // Lookup mit neuer Nummer L-200 → miss
      .mockResolvedValueOnce({ data: [{ id: 7, company: "Muster GmbH", identifier: "D-100" }] })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve({ ...customer, customerNumber: "L-200" })

    expect(mapping.clockinId).toBe(7)
    expect(searchForCustomersMock).toHaveBeenCalledTimes(2)
    expect(searchForCustomersMock.mock.calls[0][0]).toMatchObject({
      body: { scopes: [{ name: "byNameOrNumber", parameters: ["L-200"] }] },
    })
    expect(searchForCustomersMock.mock.calls[1][0]).toMatchObject({
      body: { scopes: [{ name: "byNameOrNumber", parameters: ["Muster GmbH"] }] },
    })
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("falls back to the dimacon id when no customer number exists", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockResolvedValue({ data: { id: 43 } })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve({ ...customer, customerNumber: undefined })

    expect(mapping.number).toBe("cust-1")
    expect(createCustomerMock.mock.calls[0][0]).toMatchObject({
      body: { identifier: "cust-1" },
    })
  })

  it("does not create in dryRun mode", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    const syncer = new CustomerSyncer(stubClient, silentLog, true)

    const mapping = await syncer.resolve(customer)

    expect(mapping.clockinId).toBe(-1)
    expect(createCustomerMock).not.toHaveBeenCalled()
  })
})
