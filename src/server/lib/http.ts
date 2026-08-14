/**
 * Request-Body tolerant als JSON lesen: leere oder kaputte Bodies werden zu
 * `{}` — die Zod-Validierung der Route liefert dann die aussagekräftige
 * Fehlermeldung statt eines Parse-Crashes.
 */
export async function safeJson(req: Request): Promise<unknown> {
  if (req.headers.get("content-length") === "0") return {}
  try {
    return await req.json()
  } catch {
    return {}
  }
}
