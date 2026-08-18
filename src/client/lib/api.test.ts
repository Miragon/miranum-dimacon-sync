import { describe, expect, it } from "vitest"
import { readJson } from "./api"

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, init)
}

describe("readJson", () => {
  it("parses a normal JSON body", async () => {
    await expect(readJson(response('{"ok":true}'))).resolves.toEqual({ ok: true })
  })

  it("reports an unreachable backend instead of 'Unexpected end of JSON input'", async () => {
    // Exakt was der Vite-Proxy liefert, wenn auf Port 3020 nichts läuft:
    // 502 Bad Gateway mit 0 Byte Body.
    const err = await readJson(response("", { status: 502 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Keine Antwort vom Backend \(HTTP 502\)/)
    expect((err as Error).message).not.toMatch(/Unexpected end of JSON input/)
  })

  it("flags an empty body on an otherwise successful response", async () => {
    await expect(readJson(response("", { status: 200 }))).rejects.toThrow(
      /Leere Antwort vom Server \(HTTP 200\)/,
    )
  })

  it("treats a whitespace-only body as empty", async () => {
    await expect(readJson(response("   \n  ", { status: 200 }))).rejects.toThrow(/Leere Antwort/)
  })

  it("includes a snippet when the body is not JSON (e.g. an HTML error page)", async () => {
    const err = await readJson(
      response("<!doctype html><html><body>502 Bad Gateway</body></html>", { status: 502 }),
    ).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/Ungültige JSON-Antwort \(HTTP 502\)/)
    expect((err as Error).message).toMatch(/502 Bad Gateway/)
  })

  it("truncates a long non-JSON body", async () => {
    const err = await readJson(response("x".repeat(500), { status: 500 })).catch((e: unknown) => e)
    expect((err as Error).message.length).toBeLessThan(200)
  })

  it("returns the parsed error payload for a JSON error response", async () => {
    // res.ok wird von den Aufrufern geprüft — readJson gibt den Body zurück.
    await expect(readJson(response('{"error":"boom"}', { status: 500 }))).resolves.toEqual({
      error: "boom",
    })
  })
})
