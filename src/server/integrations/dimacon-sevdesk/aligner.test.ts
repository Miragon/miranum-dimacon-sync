import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import type { SevdeskContact } from "./contact-lookup.js"

const updateCustomerMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: { updateCustomer: updateCustomerMock },
}))

const { SevdeskAligner } = await import("./aligner.js")
const { SevdeskContactIndex } = await import("./contact-index.js")
const { log } = await import("../../lib/log.js")

const silentLog = log.child({ test: true })
;(silentLog as unknown as { info: () => void }).info = () => {
  /* swallow */
}
;(silentLog as unknown as { warn: () => void }).warn = () => {
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

function sevContact(overrides: Partial<SevdeskContact> & { id: string }): SevdeskContact {
  return { name: "Muster GmbH", ...overrides }
}

function sevClient(
  overrides: { get?: ReturnType<typeof vi.fn>; post?: ReturnType<typeof vi.fn> } = {},
) {
  return {
    get: vi.fn().mockResolvedValue({ objects: [] }),
    post: vi.fn().mockResolvedValue({ objects: { id: "sev-new" } }),
    ...overrides,
  }
}

function aligner(
  sev: ReturnType<typeof sevClient>,
  opts: {
    dryRun?: boolean
    steps?: { createContacts: boolean; alignNumbers: boolean }
    onCreateProblem?: (customerId: string, message: string) => void
    duplicates?: { names: ReadonlySet<string>; numbers: ReadonlySet<string> }
    index?: InstanceType<typeof SevdeskContactIndex>
  } = {},
) {
  return new SevdeskAligner(
    dimaconClient,
    sev as never,
    silentLog,
    opts.dryRun ?? false,
    opts.steps,
    undefined,
    () => undefined,
    opts.onCreateProblem,
    opts.duplicates,
    opts.index,
  )
}

beforeEach(() => {
  updateCustomerMock.mockReset()
  updateCustomerMock.mockResolvedValue({})
})

describe("SevdeskAligner", () => {
  it("returns unchanged when the sevdesk number already matches", async () => {
    const index = new SevdeskContactIndex([sevContact({ id: "sev-1", customerNumber: "D-100" })])
    const sev = sevClient()

    const row = await aligner(sev, { index }).align(customer)

    expect(row.status).toBe("unchanged")
    expect(row.sevdeskContactId).toBe("sev-1")
    expect(sev.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("aligns the dimacon number and echoes EVERY loaded field on the full-replace PUT", async () => {
    // Feld-Erhalt-Invariante: das Dimacon-PUT ist ein Voll-Replace — der Body
    // muss ALLE geladenen Felder zurückspiegeln, sonst werden sie gelöscht.
    // Fixture mit ALLEN optionalen Feldern belegt, Assertion per toEqual.
    const index = new SevdeskContactIndex([sevContact({ id: "sev-1", customerNumber: "S-200" })])
    const sev = sevClient()

    const row = await aligner(sev, { index }).align({
      ...customer,
      phoneNumber: "089 123",
      email: "info@muster.de",
      description: "wichtiger Kunde",
      customAttributeValues: [
        { attributeId: "attr-1", value: "42" },
        { attributeId: "attr-2", value: undefined },
      ],
    })

    expect(row.status).toBe("aligned")
    expect(row.sevdeskNumber).toBe("S-200")
    expect(updateCustomerMock).toHaveBeenCalledTimes(1)
    expect(updateCustomerMock.mock.calls[0][0]).toEqual({
      client: dimaconClient,
      path: { customerId: "cust-1" },
      body: {
        name: "Muster GmbH",
        customerNumber: "S-200",
        street: "Musterweg 1",
        zipCity: "80331 München",
        phoneNumber: "089 123",
        email: "info@muster.de",
        description: "wichtiger Kunde",
        customAttributeValues: [
          { attributeId: "attr-1", value: "42" },
          { attributeId: "attr-2", value: undefined },
        ],
      },
    })
  })

  it("matches via customer number when the name is plausible", async () => {
    const index = new SevdeskContactIndex([
      sevContact({ id: "sev-1", name: "muster gmbh", customerNumber: "D-100" }),
    ])
    const sev = sevClient()

    const row = await aligner(sev, { index }).align(customer)

    expect(row.status).toBe("unchanged")
    expect(row.sevdeskContactId).toBe("sev-1")
  })

  it("reports a conflict when the number belongs to another contact and no name matches", async () => {
    const index = new SevdeskContactIndex([
      sevContact({ id: "sev-9", name: "Fremde AG", customerNumber: "D-100" }),
    ])
    const sev = sevClient()

    const row = await aligner(sev, { index }).align(customer)

    expect(row.status).toBe("conflict")
    expect(row.reason).toContain("Fremde AG")
    expect(sev.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("reports ambiguity instead of writing when several contacts share the name", async () => {
    const index = new SevdeskContactIndex([
      sevContact({ id: "sev-1" }),
      sevContact({ id: "sev-2" }),
    ])
    const sev = sevClient()

    const row = await aligner(sev, { index }).align({ ...customer, customerNumber: undefined })

    expect(row.status).toBe("ambiguous")
    expect(row.reason).toContain("sev-1")
    expect(sev.post).not.toHaveBeenCalled()
  })

  it("blocks the name stage for duplicate dimacon names in the same run", async () => {
    const sev = sevClient()
    const row = await aligner(sev, {
      index: new SevdeskContactIndex(),
      duplicates: { names: new Set(["muster gmbh"]), numbers: new Set() },
    }).align({ ...customer, customerNumber: undefined })

    expect(row.status).toBe("ambiguous")
    expect(row.reason).toContain("gleichen Namens")
    expect(sev.post).not.toHaveBeenCalled()
  })

  it("creates with the seeded dimacon number when it is provably free", async () => {
    const sev = sevClient()
    const row = await aligner(sev, { index: new SevdeskContactIndex() }).align(customer)

    expect(row.status).toBe("created")
    expect(row.sevdeskContactId).toBe("sev-new")
    // Seed sichtbar in Zeile UND Contact-Body; Nummern sind gleich → kein PUT.
    expect(row.sevdeskNumber).toBe("D-100")
    expect(sev.post.mock.calls[0][0]).toBe("/Contact")
    expect(sev.post.mock.calls[0][1]).toMatchObject({ customerNumber: "D-100" })
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("creates without a number when the dimacon number is duplicated in the run", async () => {
    const sev = sevClient()
    const row = await aligner(sev, {
      index: new SevdeskContactIndex(),
      duplicates: { names: new Set(), numbers: new Set(["d-100"]) },
    }).align(customer)

    expect(row.status).toBe("created")
    expect(row.sevdeskNumber).toBeUndefined()
    const contactBody = sev.post.mock.calls[0][1] as { customerNumber?: string }
    expect(contactBody.customerNumber).toBeUndefined()
  })

  it("creates address and communication ways as separate sevdesk resources", async () => {
    const sev = sevClient()
    await aligner(sev, { index: new SevdeskContactIndex() }).align({
      ...customer,
      phoneNumber: "089 123",
      email: "info@muster.de",
    })

    const paths = sev.post.mock.calls.map((c) => c[0])
    expect(paths).toEqual(["/Contact", "/ContactAddress", "/CommunicationWay", "/CommunicationWay"])
    expect(sev.post.mock.calls[1][1]).toMatchObject({
      street: "Musterweg 1",
      zip: "80331",
      city: "München",
      contact: { id: "sev-new", objectName: "Contact" },
    })
  })

  it("keeps status created when a sub-resource write fails, but reports the problem", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ objects: { id: "sev-new" } })
      .mockRejectedValueOnce(new Error("sevDesk API 500: kaputt"))
    const problems: string[] = []
    const sev = sevClient({ post })

    const row = await aligner(sev, {
      index: new SevdeskContactIndex(),
      onCreateProblem: (_id, message) => problems.push(message),
    }).align(customer)

    expect(row.status).toBe("created")
    expect(row.reason).toContain("Adresse konnte nicht angelegt werden")
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("Muster GmbH")
  })

  it("aligns immediately after create when sevdesk assigned a different number", async () => {
    const post = vi.fn().mockResolvedValue({ objects: { id: "sev-new", customerNumber: "S-777" } })
    const sev = sevClient({ post })

    const row = await aligner(sev, { index: new SevdeskContactIndex() }).align({
      ...customer,
      street: undefined,
      zipCity: undefined,
    })

    expect(row.status).toBe("created")
    expect(row.sevdeskNumber).toBe("S-777")
    expect(row.reason).toContain("D-100 → S-777")
    expect(updateCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("registers created contacts in the index so they are immediately findable", async () => {
    const index = new SevdeskContactIndex()
    const sev = sevClient()

    await aligner(sev, { index }).align(customer)

    expect(await index.byName("Muster GmbH")).toHaveLength(1)
    expect(await index.byNumber("D-100")).toHaveLength(1)
  })

  it("dry-run reports the pending create without writing anything", async () => {
    const sev = sevClient()
    const row = await aligner(sev, { index: new SevdeskContactIndex(), dryRun: true }).align(
      customer,
    )

    expect(row.status).toBe("created")
    expect(row.reason).toContain("[dryRun]")
    expect(sev.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("skips missing contacts when the create step is disabled", async () => {
    const sev = sevClient()
    const row = await aligner(sev, {
      index: new SevdeskContactIndex(),
      steps: { createContacts: false, alignNumbers: true },
    }).align(customer)

    expect(row.status).toBe("skipped")
    expect(sev.post).not.toHaveBeenCalled()
  })

  it("falls back to exact-verified server search without an index", async () => {
    // Serversuche: dem Filter wird nie vertraut — ein Substring-Treffer
    // ("Muster GmbH & Co") zählt nicht als der gesuchte Kontakt.
    const get = vi.fn().mockResolvedValue({
      objects: [sevContact({ id: "sev-8", name: "Muster GmbH & Co", customerNumber: "X-1" })],
    })
    const sev = sevClient({ get })

    const row = await aligner(sev, {}).align({ ...customer, customerNumber: undefined })

    expect(row.status).toBe("created")
    expect(get).toHaveBeenCalledWith("/Contact", { name: "Muster GmbH", depth: "1", limit: "1000" })
  })
})
