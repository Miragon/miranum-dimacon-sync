/**
 * Base-URLs früh prüfen: `new URL("localhost:8080")` wirft *nicht*, sondern
 * liefert das Schema "localhost:" — der Fehler taucht sonst erst tief im Sync
 * als undici-"fetch failed (unknown scheme)" auf.
 */
export function assertHttpUrl(name: string, value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)} is not a valid URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid ${name}: ${JSON.stringify(value)} must start with http:// or https:// ` +
        `(parsed scheme: "${parsed.protocol}")`,
    )
  }
  return value
}

/** Zod-taugliche Variante: boolean statt throw. */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}
