import { describe, expect, it, vi } from "vitest"

/**
 * Die Kopplung ist load-bearing: ohne First-Party-Domain MUSS der
 * Refresh-Token lokal liegen, sonst schickt authkit ihn weder im Body noch als
 * Cookie und WorkOS antwortet mit `Missing refresh token` — es gäbe dann gar
 * keinen Refresh mehr.
 */
describe("WORKOS_KEEP_REFRESH_TOKEN_LOCALLY", () => {
  it("hält den Token lokal, solange keine eigene Auth-Domain gesetzt ist", async () => {
    vi.resetModules()
    vi.stubEnv("VITE_WORKOS_API_HOSTNAME", "")

    const mod = await import("./auth-flag")

    expect(mod.WORKOS_API_HOSTNAME).toBeUndefined()
    expect(mod.WORKOS_KEEP_REFRESH_TOKEN_LOCALLY).toBe(true)
    vi.unstubAllEnvs()
  })

  it("schaltet auf den Cookie-Modus zurück, sobald eine Domain gesetzt ist", async () => {
    vi.resetModules()
    vi.stubEnv("VITE_WORKOS_API_HOSTNAME", "auth.example.com")

    const mod = await import("./auth-flag")

    expect(mod.WORKOS_API_HOSTNAME).toBe("auth.example.com")
    expect(mod.WORKOS_KEEP_REFRESH_TOKEN_LOCALLY).toBe(false)
    vi.unstubAllEnvs()
  })
})
