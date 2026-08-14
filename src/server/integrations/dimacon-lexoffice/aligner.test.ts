import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"

const updateCustomerMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: { updateCustomer: updateCustomerMock },
}))

const { CustomerAligner } = await import("./aligner.js")
const { log } = await import("../../lib/log.js")

const silentLog = log.child({ test: true })
;(silentLog as unknown as { info: () => void }).info = () => {
  /* swallow */
}

const dimaconClient = {} as never

const customer: DimaconCustomerInfo = {
  id: "cust-1",
  customerNumber: "D-100",
  name: "Muster GmbH",
  street: "Musterweg 1",
  zipCity: "80331 München",
}

function lexClient(overrides: { get?: unknown; post?: unknown } = {}) {
  return {
    get: vi.fn().mockResolvedValue({ content: [] }),
    post: vi.fn().mockResolvedValue({ id: "lex-new", version: 0 }),
    ...overrides,
  }
}

beforeEach(() => {
  updateCustomerMock.mockReset()
  updateCustomerMock.mockResolvedValue({})
})

describe("CustomerAligner", () => {
  it("returns unchanged when the lexware number already matches", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "D-100" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("unchanged")
    expect(row.lexwareContactId).toBe("lex-1")
    expect(lex.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("aligns the dimacon number when the lexware number differs", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("aligned")
    expect(row.lexwareNumber).toBe("L-200")
    expect(updateCustomerMock).toHaveBeenCalledTimes(1)
    expect(updateCustomerMock.mock.calls[0][0]).toMatchObject({
      path: { customerId: "cust-1" },
      body: { name: "Muster GmbH", customerNumber: "L-200" },
    })
  })

  it("echoes custom attribute values and description on the alignment write-back", async () => {
    // Regression: das Dimacon-PUT ist ein Voll-Replace — ein leeres
    // customAttributeValues-Array hat die Attributwerte gelöscht.
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    await aligner.align({
      ...customer,
      description: "wichtiger Kunde",
      customAttributeValues: [{ attributeId: "attr-1", value: "42" }],
    })

    expect(updateCustomerMock.mock.calls[0][0].body).toMatchObject({
      description: "wichtiger Kunde",
      customAttributeValues: [{ attributeId: "attr-1", value: "42" }],
    })
  })

  it("skips creation when the createContacts step is off", async () => {
    const lex = lexClient()
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false, {
      createContacts: false,
      alignNumbers: true,
    })

    const row = await aligner.align(customer)

    expect(row.status).toBe("skipped")
    expect(lex.post).not.toHaveBeenCalled()
  })

  it("skips number alignment when the alignNumbers step is off", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false, {
      createContacts: true,
      alignNumbers: false,
    })

    const row = await aligner.align(customer)

    expect(row.status).toBe("unchanged")
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("does not align when the dimacon customer has no number", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align({ ...customer, customerNumber: undefined })

    expect(row.status).toBe("unchanged")
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("creates a lexware contact when none matches by name", async () => {
    const lex = lexClient()
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("created")
    expect(row.lexwareContactId).toBe("lex-new")
    expect(lex.post).toHaveBeenCalledTimes(1)
    // Default-Zuordnung reproduziert den bisherigen hartkodierten Body
    expect((lex.post as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      version: 0,
      roles: { customer: {} },
      company: { name: "Muster GmbH" },
      addresses: {
        billing: [
          {
            supplement: undefined,
            street: "Musterweg 1",
            zip: "80331",
            city: "München",
            countryCode: "DE",
          },
        ],
      },
    })
    // Create-Response enthält keine roles → kein Alignment in diesem Lauf
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("performs no writes in dryRun mode", async () => {
    const lexMissing = lexClient()
    const alignerMissing = new CustomerAligner(dimaconClient, lexMissing as never, silentLog, true)
    const created = await alignerMissing.align(customer)
    expect(created.status).toBe("created")
    expect(lexMissing.post).not.toHaveBeenCalled()

    const lexDiffers = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const alignerDiffers = new CustomerAligner(dimaconClient, lexDiffers as never, silentLog, true)
    const aligned = await alignerDiffers.align(customer)
    expect(aligned.status).toBe("aligned")
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })
})
