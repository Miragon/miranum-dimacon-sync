import { describe, expect, it, vi } from "vitest"
import { loadVoucherCandidates } from "./voucher-candidates.js"

function voucher(overrides: Record<string, unknown>) {
  return {
    id: "v-1",
    voucherType: "quotation",
    voucherStatus: "open",
    voucherNumber: "AG0001",
    contactId: "lex-1",
    contactName: "Neu Bau GmbH",
    ...overrides,
  }
}

describe("loadVoucherCandidates", () => {
  it("queries quotations and order confirmations from the given date", async () => {
    const get = vi.fn().mockResolvedValue({ content: [], totalPages: 1, last: true })

    await loadVoucherCandidates({ get } as never, "2026-09-05")

    expect(get).toHaveBeenCalledWith("/v1/voucherlist", {
      voucherType: "quotation,orderconfirmation",
      voucherStatus: "any",
      voucherDateFrom: "2026-09-05",
      page: "0",
      size: "250",
    })
  })

  it("collects one candidate per contact with all its voucher numbers", async () => {
    const get = vi.fn().mockResolvedValue({
      content: [
        voucher({ id: "v-1", voucherNumber: "AG0001" }),
        voucher({ id: "v-2", voucherNumber: "AB0001", voucherType: "orderconfirmation" }),
        // Entwurf ohne Nummer: die Beleg-ID steht stellvertretend
        voucher({
          id: "v-3",
          voucherNumber: undefined,
          voucherStatus: "draft",
          contactId: "lex-2",
        }),
      ],
      totalPages: 1,
      last: true,
    })

    const candidates = await loadVoucherCandidates({ get } as never, "2026-09-05")

    expect(candidates).toEqual([
      { contactId: "lex-1", contactName: "Neu Bau GmbH", vouchers: ["AG0001", "AB0001"] },
      { contactId: "lex-2", contactName: "Neu Bau GmbH", vouchers: ["v-3"] },
    ])
  })

  it("drops vouchers without contact and rejected/voided vouchers", async () => {
    const get = vi.fn().mockResolvedValue({
      content: [
        voucher({ contactId: null }),
        voucher({ contactId: "lex-2", voucherStatus: "rejected" }),
        voucher({ contactId: "lex-3", voucherStatus: "voided" }),
      ],
      totalPages: 1,
      last: true,
    })

    expect(await loadVoucherCandidates({ get } as never, "2026-09-05")).toEqual([])
  })

  it("follows pagination", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ content: [voucher({})], totalPages: 2, last: false })
      .mockResolvedValueOnce({
        content: [voucher({ contactId: "lex-2" })],
        totalPages: 2,
        last: true,
      })

    const candidates = await loadVoucherCandidates({ get } as never, "2026-09-05")

    expect(candidates?.map((c) => c.contactId)).toEqual(["lex-1", "lex-2"])
    expect(get.mock.calls[1][1]).toMatchObject({ page: "1" })
  })

  it("discards the list when a later page fails (fail-closed)", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ content: [voucher({})], totalPages: 2, last: false })
      // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
      .mockRejectedValueOnce(new Error("boom 400"))

    expect(await loadVoucherCandidates({ get } as never, "2026-09-05")).toBeUndefined()
  })

  it("discards a response without page information", async () => {
    const get = vi.fn().mockResolvedValue({ content: [voucher({})] })
    expect(await loadVoucherCandidates({ get } as never, "2026-09-05")).toBeUndefined()
  })

  it("discards the list above the page cap without loading it", async () => {
    const get = vi.fn().mockResolvedValue({ content: [], totalPages: 3, last: false })
    expect(
      await loadVoucherCandidates({ get } as never, "2026-09-05", undefined, 2),
    ).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(1)
  })
})
