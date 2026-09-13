// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

vi.stubEnv("VITE_WORKOS_CLIENT_ID", "client_test")

const { pinOrganization } = await import("./workos-org-pin")

afterEach(() => {
  sessionStorage.clear()
})

describe("pinOrganization", () => {
  // Der Schlüsselname ist ein PRIVATES Detail von authkit-js (`orgIdKey()` in
  // create-client.ts, gepinnt auf 0.20.0). Dieser Test macht ein Umbenennen in
  // einer neuen Version laut, statt den Schutz still wirkungslos werden zu lassen.
  it("schreibt die Organisation unter den authkit-Schlüssel zurück", () => {
    pinOrganization("org_42")

    expect(sessionStorage.getItem("workos-org-id:client_test")).toBe("org_42")
  })

  it("tut nichts ohne Organisation", () => {
    pinOrganization(null)

    expect(sessionStorage.getItem("workos-org-id:client_test")).toBeNull()
  })

  it("schluckt einen gesperrten Storage, statt den Refresh scheitern zu lassen", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })

    expect(() => pinOrganization("org_42")).not.toThrow()

    setItem.mockRestore()
  })
})
