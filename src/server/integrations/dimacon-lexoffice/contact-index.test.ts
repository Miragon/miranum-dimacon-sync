import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"
import { LexwareContactIndex, loadLexwareContactIndex } from "./contact-index.js"
import type { LexContact } from "./contact-lookup.js"

const noop = () => {
  /* swallow */
}
const warnings: string[] = []
const silentLog: Logger = {
  debug: noop,
  info: noop,
  warn: (message) => void warnings.push(message),
  error: noop,
  child: () => silentLog,
}

const get = vi.fn()
const client = { get } as never

function contact(id: string, name: string, number?: string | number): LexContact {
  return {
    id,
    version: 1,
    company: { name },
    roles: { customer: number === undefined ? {} : { number } },
  }
}

function page(content: LexContact[], number: number, totalPages: number) {
  return { content, number, totalPages, last: number === totalPages - 1 }
}

beforeEach(() => {
  vi.resetAllMocks()
  warnings.length = 0
})

describe("LexwareContactIndex", () => {
  it("resolves every contact by id — also archived ones, which number/name skip", async () => {
    const archived = { ...contact("lex-2", "Alt GmbH", 10002), archived: true }
    const index = new LexwareContactIndex([contact("lex-1", "Muster GmbH", 10001), archived])

    expect(index.byId("lex-1")?.company?.name).toBe("Muster GmbH")
    // byId ist ungefiltert: die Übernahme muss begründen können, warum sie
    // einen Beleg-Kontakt NICHT anlegt
    expect(index.byId("lex-2")).toBe(archived)
    expect(await index.byName("Alt GmbH")).toEqual([])
    expect(index.byId("lex-x")).toBeUndefined()
  })

  it("matches by number and by normalised name", async () => {
    const index = new LexwareContactIndex([contact("lex-1", "Muster GmbH", 1001)])

    expect((await index.byNumber("1001")).map((c) => c.id)).toEqual(["lex-1"])
    expect((await index.byName("  muster   gmbh ")).map((c) => c.id)).toEqual(["lex-1"])
    expect(await index.byNumber("9999")).toEqual([])
  })

  it("keeps ALL candidates per key so ambiguity stays visible", async () => {
    const index = new LexwareContactIndex([
      contact("lex-1", "Muster GmbH", 1),
      contact("lex-2", "Muster GmbH", 2),
    ])

    expect((await index.byName("Muster GmbH")).map((c) => c.id)).toEqual(["lex-1", "lex-2"])
  })

  it("ignores contacts that are not active customers", async () => {
    const index = new LexwareContactIndex([
      { id: "vendor", version: 1, company: { name: "Nur Lieferant" }, roles: { vendor: {} } },
      { ...contact("archiviert", "Alt GmbH", 5), archived: true },
    ])

    expect(await index.byName("Nur Lieferant")).toEqual([])
    expect(await index.byNumber("5")).toEqual([])
    expect(index.size).toBe(0)
  })

  it("makes a contact created during the run findable immediately", async () => {
    const index = new LexwareContactIndex()

    index.add(contact("lex-neu", "Neu GmbH"))

    expect((await index.byName("Neu GmbH")).map((c) => c.id)).toEqual(["lex-neu"])
  })
})

describe("loadLexwareContactIndex", () => {
  it("paginates with page/size and indexes every page", async () => {
    get
      .mockResolvedValueOnce(page([contact("a", "A GmbH", 1)], 0, 3))
      .mockResolvedValueOnce(page([contact("b", "B GmbH", 2)], 1, 3))
      .mockResolvedValueOnce(page([contact("c", "C GmbH", 3)], 2, 3))

    const index = await loadLexwareContactIndex(client, silentLog)

    expect(get.mock.calls.map((c) => c[1])).toEqual([
      { page: "0", size: "250" },
      { page: "1", size: "250" },
      { page: "2", size: "250" },
    ])
    expect(index?.size).toBe(3)
    expect((await index!.byName("C GmbH")).map((c) => c.id)).toEqual(["c"])
  })

  it("stops at `last: true` even when totalPages says more", async () => {
    get.mockResolvedValueOnce({ content: [contact("a", "A GmbH", 1)], last: true, totalPages: 9 })

    const index = await loadLexwareContactIndex(client, silentLog)

    expect(get).toHaveBeenCalledTimes(1)
    expect(index?.size).toBe(1)
  })

  it("discards the index when page 0 reports neither totalPages nor last", async () => {
    // Fail-closed: ohne Seitenzahl wäre der nach Seite 0 abgeschnittene Index
    // fälschlich „vollständig" — der Aligner ersetzt die Serversuche komplett
    // durch ihn und legte Kontakte späterer Seiten erneut an.
    get.mockResolvedValue({ content: [contact("a", "A GmbH", 1)] })

    const index = await loadLexwareContactIndex(client, silentLog)

    expect(index).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(1)
    expect(warnings).toContain("lexware contact index discarded — Antwort ohne totalPages/last")
  })

  it("accepts a single page that only says `last: true` without totalPages", async () => {
    // Gegenprobe zum Fail-closed-Pfad: `last: true` ist eine verlässliche
    // Vollständigkeits-Aussage, der Index darf NICHT verworfen werden.
    get.mockResolvedValue({ content: [contact("a", "A GmbH", 1)], last: true })

    const index = await loadLexwareContactIndex(client, silentLog)

    expect(get).toHaveBeenCalledTimes(1)
    expect(index?.size).toBe(1)
    expect((await index!.byName("A GmbH")).map((c) => c.id)).toEqual(["a"])
  })

  it("checks the page cap right after page 0 instead of paying maxPages requests", async () => {
    // Der Deckel steht nach Seite 0 fest. Erst in der Schleife zu prüfen hieße,
    // maxPages Requests gegen eine auf 2 req/s limitierte API zu bezahlen und
    // den Index danach trotzdem wegzuwerfen.
    get.mockResolvedValue({ content: [contact("a", "A GmbH", 1)], number: 0, totalPages: 500 })

    const index = await loadLexwareContactIndex(client, silentLog, 10)

    expect(index).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(1)
    expect(warnings).toContain("lexware contact index discarded — page cap reached")
  })

  it("warns once about duplicate company names instead of silently keeping the first", async () => {
    get.mockResolvedValueOnce(
      page([contact("a", "Muster GmbH", 1), contact("b", "Muster GmbH", 2)], 0, 1),
    )

    const index = await loadLexwareContactIndex(client, silentLog)

    expect(warnings).toContain("lexware contacts share company names")
    expect((await index!.byName("Muster GmbH")).map((c) => c.id)).toEqual(["a", "b"])
  })

  it("discards the index when the page cap is reached", async () => {
    get.mockResolvedValue(page([contact("a", "A GmbH", 1)], 0, 99))

    const index = await loadLexwareContactIndex(client, silentLog, 2)

    expect(index).toBeUndefined()
    expect(warnings).toContain("lexware contact index discarded — page cap reached")
  })

  it("discards the index when a later page fails", async () => {
    get
      .mockResolvedValueOnce(page([contact("a", "A GmbH", 1)], 0, 3))
      // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
      .mockRejectedValue(new Error("boom 400"))

    const index = await loadLexwareContactIndex(client, silentLog)

    expect(index).toBeUndefined()
    expect(warnings).toContain("lexware contact index discarded — page load failed")
  })

  it("does not retry a 429 itself — that belongs to the lexware client", async () => {
    const rateLimited = new Error("Lexoffice API 429: too many requests")
    get.mockRejectedValue(rateLimited)

    await expect(loadLexwareContactIndex(client, silentLog)).rejects.toThrow("429")
    expect(get).toHaveBeenCalledTimes(1)
  })
})
