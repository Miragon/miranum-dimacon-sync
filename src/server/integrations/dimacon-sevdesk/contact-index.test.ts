import { describe, expect, it, vi } from "vitest"
import { loadSevdeskContactIndex, SevdeskContactIndex } from "./contact-index.js"
import type { SevdeskContact } from "./contact-lookup.js"

function contact(overrides: Partial<SevdeskContact> & { id: string }): SevdeskContact {
  return { name: `Firma ${overrides.id}`, customerNumber: null, ...overrides }
}

/** Seiten-Antworten als Client-Stub: eine GET-Antwort je Aufruf. */
function clientWithPages(pages: (SevdeskContact[] | Error | { broken: true })[]) {
  const get = vi.fn()
  for (const page of pages) {
    if (page instanceof Error) get.mockRejectedValueOnce(page)
    else if (Array.isArray(page)) get.mockResolvedValueOnce({ objects: page })
    else get.mockResolvedValueOnce({})
  }
  return { get } as never
}

describe("SevdeskContactIndex", () => {
  it("keeps multiple contacts per key so ambiguity stays decidable", async () => {
    const index = new SevdeskContactIndex([
      contact({ id: "s-1", name: "Muster GmbH" }),
      contact({ id: "s-2", name: "muster gmbh" }),
    ])
    expect(await index.byName("Muster GmbH")).toHaveLength(2)
  })

  it("indexes persons via surename/familyname", async () => {
    const index = new SevdeskContactIndex([
      contact({ id: "s-1", name: null, surename: "Max", familyname: "Muster" }),
    ])
    expect(await index.byName("max muster")).toHaveLength(1)
  })

  it("ignores supplier contacts (category 2), keeps custom categories", async () => {
    const index = new SevdeskContactIndex([
      contact({ id: "s-1", name: "Muster GmbH", category: { id: "2" } }),
      contact({ id: "s-2", name: "Beispiel AG", category: { id: 5001 } }),
    ])
    expect(await index.byName("Muster GmbH")).toHaveLength(0)
    expect(await index.byName("Beispiel AG")).toHaveLength(1)
  })

  it("resolves by trimmed customer number (numbers may arrive as numbers)", async () => {
    const index = new SevdeskContactIndex([contact({ id: "s-1", customerNumber: 1001 })])
    expect(await index.byNumber(" 1001 ")).toHaveLength(1)
  })
})

describe("loadSevdeskContactIndex", () => {
  it("paginates until a short page and indexes everything", async () => {
    const pageA = Array.from({ length: 1000 }, (_, i) => contact({ id: `a-${i}` }))
    const pageB = [contact({ id: "b-0", name: "Letzte GmbH" })]
    const client = clientWithPages([pageA, pageB])

    const index = await loadSevdeskContactIndex(client)

    expect(index?.size).toBe(1001)
    expect(await index?.byName("Letzte GmbH")).toHaveLength(1)
  })

  it("discards the index when a later page fails (fail-closed)", async () => {
    const pageA = Array.from({ length: 1000 }, (_, i) => contact({ id: `a-${i}` }))
    const client = clientWithPages([pageA, new Error("boom")])

    expect(await loadSevdeskContactIndex(client)).toBeUndefined()
  })

  it("discards the index on a response without objects array (fail-closed)", async () => {
    const client = clientWithPages([{ broken: true }])
    expect(await loadSevdeskContactIndex(client)).toBeUndefined()
  })

  it("discards the index when the page cap is reached", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => contact({ id: `x-${i}` }))
    const client = clientWithPages([full, full, full])
    expect(await loadSevdeskContactIndex(client, undefined, 2)).toBeUndefined()
  })

  it("throws on a first-page failure — the caller decides", async () => {
    const client = clientWithPages([new Error("down")])
    await expect(loadSevdeskContactIndex(client)).rejects.toThrow("down")
  })
})
