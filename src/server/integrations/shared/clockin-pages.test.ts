import { describe, expect, it, vi } from "vitest"
import { loadAllClockinPages } from "./clockin-pages.js"
import type { ClockinPage } from "./clockin-pages.js"

interface Row {
  id?: number
}

/** Baut eine Seite mit fortlaufenden IDs (Seite 2 ⇒ 21, 22 …) */
function page(current: number, lastPage: number, size = 2): ClockinPage<Row> {
  const rows: Row[] = []
  for (let i = 0; i < size; i++) rows.push({ id: (current - 1) * 10 + i + 1 })
  return { data: rows, meta: { current_page: current, last_page: lastPage, per_page: size } }
}

describe("loadAllClockinPages", () => {
  it("reads a single page without sending the page query", async () => {
    const fetchPage = vi.fn(async () => page(1, 1))

    const result = await loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id })

    expect(result).toMatchObject({ complete: true, pages: 1 })
    expect(result.rows.map((r) => r.id)).toEqual([1, 2])
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage).toHaveBeenCalledWith(undefined)
  })

  it("follows every page and concatenates the rows", async () => {
    const fetchPage = vi.fn(async (p: number | undefined) => page(p ?? 1, 3))

    const result = await loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id })

    expect(result).toMatchObject({ complete: true, pages: 3 })
    expect(result.reason).toBeUndefined()
    expect(result.rows.map((r) => r.id)).toEqual([1, 2, 11, 12, 21, 22])
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([undefined, 2, 3])
  })

  it("stops when the api ignores the page parameter", async () => {
    // current_page bleibt 1 ⇒ die API liefert immer dieselbe Seite
    const fetchPage = vi.fn(async () => page(1, 4))

    const result = await loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id })

    expect(result.complete).toBe(false)
    expect(result.reason).toContain("ignoriert")
    expect(result.pages).toBe(2)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    // Zeilen der ersten Seite bleiben erhalten (Dedupe über die IDs)
    expect(result.rows.map((r) => r.id)).toEqual([1, 2])
  })

  it("stops when a follow-up page brings no new ids", async () => {
    const fetchPage = vi.fn(async (p: number | undefined) =>
      p === undefined ? page(1, 3) : { ...page(1, 3), meta: { current_page: p, last_page: 3 } },
    )

    const result = await loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id })

    expect(result.complete).toBe(false)
    expect(result.reason).toContain("keine neuen Datensätze")
    expect(result.rows).toHaveLength(2)
  })

  it("keeps the rows loaded so far when a follow-up page fails", async () => {
    const fetchPage = vi.fn(async (p: number | undefined) => {
      if (p === 3) throw new Error("boom 500")
      return page(p ?? 1, 4)
    })

    const result = await loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id })

    expect(result.complete).toBe(false)
    expect(result.reason).toContain("Seite 3 konnte nicht geladen werden")
    expect(result.reason).toContain("boom 500")
    expect(result.rows.map((r) => r.id)).toEqual([1, 2, 11, 12])
    expect(result.pages).toBe(2)
  })

  it("propagates an error on the first page — that is a hard load failure", async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error("boom 401")
    })

    await expect(loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id })).rejects.toThrow(
      "boom 401",
    )
  })

  it("caps the number of pages and reports the base as incomplete", async () => {
    const fetchPage = vi.fn(async (p: number | undefined) => page(p ?? 1, 99))

    const result = await loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id, maxPages: 3 })

    expect(result.pages).toBe(3)
    expect(result.complete).toBe(false)
    expect(result.reason).toContain("mehr als 3 Seiten")
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it("tolerates rows without an id and treats missing meta as one page by default", async () => {
    // Permissiver Default mit Absicht: Aufrufer, die nur Zeilen verarbeiten,
    // tun auf einer Teilliste höchstens zu wenig (siehe requireMeta).
    const fetchPage = vi.fn(async () => ({ data: [{}, { id: 5 }] }) as ClockinPage<Row>)

    const result = await loadAllClockinPages<Row>({ fetchPage, idOf: (r) => r.id })

    expect(result).toMatchObject({ complete: true, pages: 1 })
    expect(result.rows).toHaveLength(2)
  })

  it("reports a response without meta.last_page as incomplete with requireMeta", async () => {
    // Ohne meta ist die Seitenzahl unbekannt — Aufrufer, die darauf Anlagen
    // stützen, dürfen das nicht als „eine Seite" geschenkt bekommen.
    const fetchPage = vi.fn(async () => ({ data: [{ id: 5 }] }) as ClockinPage<Row>)

    const result = await loadAllClockinPages<Row>({
      fetchPage,
      idOf: (r) => r.id,
      requireMeta: true,
    })

    expect(result.complete).toBe(false)
    expect(result.reason).toContain("meta.last_page")
    // Die geladene Seite bleibt nutzbar — gesperrt ist nur die Anlage.
    expect(result.rows).toHaveLength(1)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it("treats a null meta.last_page as unknown too", async () => {
    // Gleiches Kriterium wie in customer-index.ts — sonst driften die beiden
    // fail-closed-Wächter auseinander.
    const fetchPage = vi.fn(
      async () => ({ data: [{ id: 5 }], meta: { last_page: null } }) as unknown as ClockinPage<Row>,
    )

    const result = await loadAllClockinPages<Row>({
      fetchPage,
      idOf: (r) => r.id,
      requireMeta: true,
    })

    expect(result.complete).toBe(false)
  })
})
